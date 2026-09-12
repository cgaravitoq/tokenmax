/// <reference types="astro/client" />
/// <reference path="../worker-configuration.d.ts" />

declare namespace Cloudflare {
  interface Env {
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    PRIVACY_AUTHORITY_NAME: string;
    PRIVACY_AUTHORITY_URL: string;
    PRIVACY_CONTROLLER: string;
    PRIVACY_EMAIL: string;
  }
}
