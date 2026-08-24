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

Gio._promisify(Goa.Client, 'new', 'new_finish');
Gio._promisify(Goa.OAuth2Based.prototype, 'call_get_access_token', 'call_get_access_token_finish');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

export class GoogleTasksManager {
  private _cancellable: Gio.Cancellable;
  private _httpSession: Soup.Session;
  private _accessToken: string | null = null;
  private _accessTokenExpiresAtMs: number = 0;

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

    return { lists, tasks: tasksByList.flat() };
  }

  async createTask(title: string, notes?: string, taskListId?: string, parentTaskId?: string): Promise<GoogleTask> {
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
    return { ...created, taskListId: resolvedTaskListId };
  }

  async completeTask(taskListId: string, taskId: string): Promise<void> {
    await this._request(this._taskUrl(taskListId, taskId), 'PATCH', { status: 'completed' });
  }

  async uncompleteTask(taskListId: string, taskId: string): Promise<void> {
    await this._request(this._taskUrl(taskListId, taskId), 'PATCH', { status: 'needsAction' });
  }

  async updateTask(taskListId: string, taskId: string, title: string, notes?: string): Promise<void> {
    const body: Record<string, string> = { title };
    if (notes !== undefined)
      body.notes = notes;
    await this._request(this._taskUrl(taskListId, taskId), 'PATCH', body);
  }

  async deleteTask(taskListId: string, taskId: string): Promise<void> {
    await this._request(this._taskUrl(taskListId, taskId), 'DELETE');
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