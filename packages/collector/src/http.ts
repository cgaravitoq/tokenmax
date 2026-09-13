export interface HttpResponse {
  status: number;
  text(): Promise<string>;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<HttpResponse>;
