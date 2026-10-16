import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
// @ts-expect-error: Goa types are not available
import Goa from 'gi://Goa';
// @ts-expect-error: Soup types are not available
import Soup from 'gi://Soup';

export interface GoogleTask {
  id: string;
  title: string;
  notes?: string;
  status: string;
  taskListId?: string;
  parent?: string;
  due?: string;
  updated?: string;
  completed?: string;
  position?: string;
  children?: GoogleTask[];
}

export interface GoogleTaskList {
  id: string;
  title: string;
}

interface PagedResponse<T> {
  items?: T[];
  nextPageToken?: string;
}

const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';

// The API returns 20 items per page by default and allows at most 100. Without
// asking for the maximum and following nextPageToken, a list holding more than
// 20 tasks is silently truncated.
const PAGE_SIZE = 100;

// Safety net against a nextPageToken that never clears: 20 pages is 2000 tasks,
// well past anything this panel can usefully show.
const MAX_PAGES = 20;

// Access tokens are cached until shortly before they expire. Fetching one is an
// IPC round-trip to GNOME Online Accounts, and it used to happen for every
// single request — including once per task list on every refresh.
const TOKEN_EXPIRY_MARGIN_SECONDS = 60;
const TOKEN_FALLBACK_LIFETIME_SECONDS = 240;

// How long to trust a status/deletion we just made locally over what a
// reconcile fetch reports, if they disagree. Google's API can briefly return
// the pre-change state right after a successful write (eventual consistency)
// — without this, a reconcile landing in that window flips the task back (or
// resurrects a just-deleted one), then a later reconcile flips it forward
// again once the read catches up, which reads as the row bouncing on its own.
const RECONCILE_OVERRIDE_TTL_MS = 30000;

Gio._promisify(Goa.Client, 'new', 'new_finish');
Gio._promisify(Goa.OAuth2Based.prototype, 'call_get_access_token', 'call_get_access_token_finish');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retries a failing network call a few times with backoff before giving up.
// Transient failures (dropped connections, momentary TLS handshake errors —
// exactly what shows up in the logs) were previously treated as permanent,
// triggering an immediate full refetch that rolled the optimistic UI back.
// A cancelled request (extension disabling mid-call) is never retried — the
// caller is going away, so waiting out the backoff would only delay teardown.
async function withRetry<T>(fn: () => Promise<T>, retries = 2, baseDelayMs = 200): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    }
    catch (e) {
      lastError = e;
      if (isCancelledError(e))
        break;
      if (attempt < retries)
        await delay(baseDelayMs * (attempt + 1));
    }
  }
  throw lastError;
}

export class GoogleTasksManager {
  private _cancellable: Gio.Cancellable;
  private _httpSession: Soup.Session;
  private _accessToken: string | null = null;
  private _accessTokenExpiresAtMs: number = 0;

  // Optimistic state applied on top of every fetch, so a reconcile that lands
  // while Google's read replicas are still catching up with a just-made
  // write doesn't visibly flip a row back. Owned here (not by the caller)
  // because completeTask/uncompleteTask/deleteTask are the only ones who
  // know when an override should start and when it should be rolled back.
  private _statusOverrides: Map<string, { status: string; expiresAt: number }> = new Map();
  private _pendingDeletions: Map<string, number> = new Map();

  // A task just created here can be temporarily missing from a fetch — the
  // same read-replica lag that motivates _statusOverrides/_pendingDeletions
  // — which otherwise makes it flicker: shown optimistically, then dropped
  // by the next reconcile (which rebuilds its list purely from the fetch),
  // then restored once a later fetch catches up. Held onto until the fetch
  // agrees or the entry lapses.
  private _recentlyCreated: Map<string, { task: GoogleTask; expiresAt: number }> = new Map();

  // Serializes mutations per task id: without this, quickly flipping a task
  // between active and completed fires a completeTask and an uncompleteTask
  // request in parallel, and if their responses arrive out of send-order the
  // server ends up in the state opposite of the user's last click.
  private _mutationQueues: Map<string, Promise<unknown>> = new Map();

  constructor() {
    this._cancellable = new Gio.Cancellable();
    this._httpSession = new Soup.Session();
  }

  private async _getAccessToken(): Promise<string> {
    if (this._accessToken && Date.now() < this._accessTokenExpiresAtMs)
      return this._accessToken;

    const client = await Goa.Client.new(this._cancellable);
    const accounts = client.get_accounts();
    const googleAccount = accounts.find((acc: any) => acc.get_account().provider_type === 'google');
    if (!googleAccount)
      throw new Error('No Google account found in Online Accounts');
    const oauth2 = googleAccount.get_oauth2_based();
    if (!oauth2)
      throw new Error('Google account does not support OAuth2');

    const [accessToken, expiresIn] = await oauth2.call_get_access_token(this._cancellable);
    const lifetime = typeof expiresIn === 'number' && expiresIn > TOKEN_EXPIRY_MARGIN_SECONDS
      ? expiresIn - TOKEN_EXPIRY_MARGIN_SECONDS
      : TOKEN_FALLBACK_LIFETIME_SECONDS;

    this._accessToken = accessToken;
    this._accessTokenExpiresAtMs = Date.now() + lifetime * 1000;
    return accessToken;
  }

  private _invalidateAccessToken() {
    this._accessToken = null;
    this._accessTokenExpiresAtMs = 0;
  }

  /**
   * Fetches task lists and all their tasks in one cycle: a single token fetch
   * and a single lists request, rather than each caller re-fetching both.
   * The result already has locally-known optimistic mutations reconciled in
   * — see _reconcile().
   *
   * Failures propagate instead of resolving to empty arrays. An empty result
   * and a failed request look identical to the caller otherwise, so a momentary
   * network hiccup would blank the panel and the next refresh would fill it
   * back in — which reads as tasks flickering in and out.
   */
  async getListsAndTasks(includeCompleted: boolean = false): Promise<{ lists: GoogleTaskList[]; tasks: GoogleTask[] }> {
    const lists = await this._fetchAllPages<GoogleTaskList>(`${TASKS_API}/users/@me/lists`);

    const showCompleted = includeCompleted ? 'true' : 'false';
    const tasksByList = await Promise.all(lists.map(async (list) => {
      // showHidden is intentionally always false: it surfaces tasks the user
      // explicitly cleared from a completed list, not merely "completed".
      const url = `${TASKS_API}/lists/${encodeURIComponent(list.id)}/tasks?showCompleted=${showCompleted}&showHidden=false`;
      try {
        const tasks = await this._fetchAllPages<GoogleTask>(url);
        return tasks.map(task => ({ ...task, taskListId: list.id }));
      }
      catch (error) {
        // One unreadable list shouldn't cost the user the others.
        console.error(`Google Tasks: Failed to fetch tasks for list ${list.title}: ${describeError(error)}`);
        return [] as GoogleTask[];
      }
    }));

    return { lists, tasks: this._reconcile(tasksByList.flat()) };
  }

  // Applies locally-known optimistic state on top of a fresh fetch: a status
  // just set by completeTask/uncompleteTask takes precedence over a fetch
  // that still disagrees, a task just removed by deleteTask stays hidden
  // until the fetch stops mentioning it or the override lapses, and a task
  // just made by createTask stays visible even if this particular fetch
  // doesn't have it yet.
  private _reconcile(tasks: GoogleTask[]): GoogleTask[] {
    // The common case: nothing was mutated since the last fetch, so there's
    // nothing to reconcile. Skip the sweeps and the full-array rebuild below
    // — this runs on every poll (every REFRESH_INTERVAL_SECONDS), not just
    // right after a mutation.
    if (this._statusOverrides.size === 0 && this._pendingDeletions.size === 0 && this._recentlyCreated.size === 0)
      return tasks;

    const now = Date.now();

    for (const [id, expiresAt] of this._pendingDeletions) {
      if (now > expiresAt)
        this._pendingDeletions.delete(id);
    }
    for (const [id, entry] of this._recentlyCreated) {
      if (now > entry.expiresAt)
        this._recentlyCreated.delete(id);
    }
    if (this._pendingDeletions.size > 0 || this._recentlyCreated.size > 0) {
      const seenIds = new Set(tasks.map(task => task.id));
      for (const id of [...this._pendingDeletions.keys()]) {
        if (!seenIds.has(id))
          this._pendingDeletions.delete(id);
      }
      // Seen for real now — the fetched copy (any later edits included)
      // takes over, so this stops shadowing it.
      for (const id of [...this._recentlyCreated.keys()]) {
        if (seenIds.has(id))
          this._recentlyCreated.delete(id);
      }
    }

    // A still-unseen just-created task isn't in `tasks` at all — fold it in
    // here so the loop below applies the exact same deletion/status handling
    // to it as to a fetched task (e.g. it was created and then immediately
    // completed or deleted before any fetch caught up).
    const candidates = this._recentlyCreated.size > 0
      ? [...tasks, ...[...this._recentlyCreated.values()].map(entry => entry.task)]
      : tasks;

    const reconciled: GoogleTask[] = [];
    for (const task of candidates) {
      if (this._pendingDeletions.has(task.id))
        continue;

      let effectiveStatus = task.status;
      const override = this._statusOverrides.get(task.id);
      if (override) {
        if (now > override.expiresAt) {
          this._statusOverrides.delete(task.id);
        }
        else if (task.status !== override.status) {
          // The fetch disagrees with what was just set — likely a stale
          // (not-yet-replicated) read. Trust the recent write instead of
          // visibly flipping the row back.
          effectiveStatus = override.status;
        }
        else {
          // The fetch now agrees — the server has caught up.
          this._statusOverrides.delete(task.id);
        }
      }

      reconciled.push(effectiveStatus === task.status ? task : { ...task, status: effectiveStatus });
    }
    return reconciled;
  }

  async createTask(title: string, notes?: string, taskListId?: string, parentTaskId?: string): Promise<GoogleTask> {
    // Wraps list-resolution too, not just the final POST: the previous
    // caller-side retry (before this moved here) covered the whole call.
    return withRetry(async () => {
      let resolvedTaskListId = taskListId;
      if (!resolvedTaskListId) {
        const lists = await this._fetchAllPages<GoogleTaskList>(`${TASKS_API}/users/@me/lists`);
        if (lists.length === 0)
          throw new Error('No task lists found');
        resolvedTaskListId = lists[0].id;
      }

      const parentParam = parentTaskId ? `?parent=${encodeURIComponent(parentTaskId)}` : '';
      const url = `${TASKS_API}/lists/${encodeURIComponent(resolvedTaskListId)}/tasks${parentParam}`;
      const body: Record<string, string> = { title };
      if (notes)
        body.notes = notes;

      const created = await this._request<GoogleTask>(url, 'POST', body);
      const task = { ...created, taskListId: resolvedTaskListId };
      this._recentlyCreated.set(task.id, { task, expiresAt: Date.now() + RECONCILE_OVERRIDE_TTL_MS });
      return task;
    });
  }

  async completeTask(taskListId: string, taskId: string): Promise<void> {
    return this._setStatus(taskListId, taskId, 'completed');
  }

  async uncompleteTask(taskListId: string, taskId: string): Promise<void> {
    return this._setStatus(taskListId, taskId, 'needsAction');
  }

  private async _setStatus(taskListId: string, taskId: string, status: string): Promise<void> {
    // Captured by reference so the rollback below only ever clears *this*
    // call's own override — not one a newer, still-in-flight call for the
    // same task id (e.g. complete then immediately uncomplete) already
    // replaced it with while this request was in flight or queued.
    const override = { status, expiresAt: Date.now() + RECONCILE_OVERRIDE_TTL_MS };
    this._statusOverrides.set(taskId, override);
    try {
      await this._runQueued(taskId, () => withRetry(() => this._request(this._taskUrl(taskListId, taskId), 'PATCH', { status })));
    }
    catch (error) {
      // A failed move looks like it worked, then silently undoes itself once
      // the override lapses, unless it's dropped right away. Left alone on
      // cancellation (extension disabling) — destroy() clears it right after.
      if (!isCancelledError(error) && this._statusOverrides.get(taskId) === override)
        this._statusOverrides.delete(taskId);
      throw error;
    }
  }

  async updateTask(taskListId: string, taskId: string, title: string, notes?: string): Promise<void> {
    const body: Record<string, string> = { title };
    if (notes !== undefined)
      body.notes = notes;
    await this._runQueued(taskId, () => withRetry(() => this._request(this._taskUrl(taskListId, taskId), 'PATCH', body)));

    // Edited right after creation, before any fetch has seen it yet: keep the
    // remembered copy (see _recentlyCreated) in sync, or a reconcile in that
    // window would show it with its pre-edit title/notes.
    const pending = this._recentlyCreated.get(taskId);
    if (pending)
      pending.task = { ...pending.task, title, notes };
  }

  async deleteTask(taskListId: string, taskId: string): Promise<void> {
    // A status override no longer means anything once the task is gone, and
    // would otherwise linger in the map until its own TTL.
    this._statusOverrides.delete(taskId);
    const deletionExpiresAt = Date.now() + RECONCILE_OVERRIDE_TTL_MS;
    this._pendingDeletions.set(taskId, deletionExpiresAt);
    try {
      await this._runQueued(taskId, () => withRetry(() => this._request(this._taskUrl(taskListId, taskId), 'DELETE')));
    }
    catch (error) {
      // Same by-reference guard as _setStatus(), against a second concurrent
      // delete of this id (not reachable today — a deleted row disappears
      // from the UI immediately — but cheap to make safe either way).
      if (!isCancelledError(error) && this._pendingDeletions.get(taskId) === deletionExpiresAt)
        this._pendingDeletions.delete(taskId);
      throw error;
    }
  }

  private _runQueued<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this._mutationQueues.get(taskId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    // Keep the queue alive regardless of outcome, so a later action on this
    // same task still waits its turn instead of racing ahead of this one.
    const queued = run.catch(() => undefined);
    this._mutationQueues.set(taskId, queued);
    // Once settled, drop the entry — otherwise every distinct task id ever
    // mutated stays in the map for the rest of the session. Only if it's
    // still *this* call's entry: a newer mutation for the same id may have
    // already replaced it while this one was in flight.
    queued.finally(() => {
      if (this._mutationQueues.get(taskId) === queued)
        this._mutationQueues.delete(taskId);
    });
    return run;
  }

  private _taskUrl(taskListId: string, taskId: string): string {
    return `${TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`;
  }

  private async _fetchAllPages<T>(url: string): Promise<T[]> {
    const separator = url.includes('?') ? '&' : '?';
    const items: T[] = [];
    let pageToken: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const tokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
      const data = await this._request<PagedResponse<T>>(`${url}${separator}maxResults=${PAGE_SIZE}${tokenParam}`);

      if (data?.items)
        items.push(...data.items);

      pageToken = data?.nextPageToken;
      if (!pageToken)
        break;
    }

    return items;
  }

  private async _request<T>(url: string, method: string = 'GET', body?: object): Promise<T> {
    const response = await this._send<T>(url, method, body, await this._getAccessToken());
    if (response.status !== 401)
      return response.result;

    // A cached token can expire early, or be revoked outright, so a single
    // unauthorized reply earns a fresh token and one retry before giving up.
    this._invalidateAccessToken();
    const retry = await this._send<T>(url, method, body, await this._getAccessToken());
    if (retry.status === 401)
      throw new Error(`HTTP 401: Unauthorized (${method} ${url})`);
    return retry.result;
  }

  private async _send<T>(url: string, method: string, body: object | undefined, token: string): Promise<{ status: number; result: T }> {
    const message = Soup.Message.new(method, url);
    message.request_headers.append('Authorization', `Bearer ${token}`);

    if (body) {
      const bytes = GLib.Bytes.new(new TextEncoder().encode(JSON.stringify(body)));
      message.set_request_body_from_bytes('application/json', bytes);
    }

    const responseBytes = await this._httpSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable);
    const status = message.get_status();
    const data = responseBytes?.get_data();
    const text = data && data.length > 0 ? new TextDecoder().decode(data) : '';

    // Any 2xx counts. Accepting only 200 and 204 left 201 Created — and every
    // other 2xx the API may return — looking like a failure even though the
    // write had gone through.
    if (status < 200 || status >= 300) {
      if (status === 401)
        return { status, result: undefined as T };
      // Google explains itself in the response body: quota exceeded, invalid
      // id, and so on. Carrying it along turns a bare "HTTP 400" in the journal
      // into something actionable.
      throw new Error(`HTTP ${status}: ${message.get_reason_phrase()}${text ? ` — ${text.slice(0, 300)}` : ''}`);
    }

    if (!text)
      return { status, result: undefined as T };

    try {
      return { status, result: JSON.parse(text) as T };
    }
    catch {
      throw new Error(`Unreadable response from ${method} ${url}`);
    }
  }

  destroy() {
    this._invalidateAccessToken();
    this._cancellable.cancel();
    this._statusOverrides.clear();
    this._pendingDeletions.clear();
    this._recentlyCreated.clear();
    this._mutationQueues.clear();
  }
}

export function isCancelledError(error: unknown): boolean {
  return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function describeError(error: unknown): string {
  if (isCancelledError(error))
    return 'cancelled';
  return error instanceof Error ? error.message : String(error);
}
