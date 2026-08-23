const API_URL = import.meta.env.VITE_API_URL;

interface ApiErrorBody {
  message?: string | string[];
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { body, headers, ...rest } = options;

  const response = await fetch(`${API_URL}${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorBody = (await response
      .json()
      .catch(() => null)) as ApiErrorBody | null;
    const message = errorBody?.message;
    throw new ApiError(
      response.status,
      Array.isArray(message)
        ? message.join(', ')
        : (message ?? `Error ${response.status}`),
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const httpClient = {
  get: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PUT', body }),
  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'DELETE' }),
};
