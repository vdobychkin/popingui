/**
 * Widens libuv's thread pool before anything can use it.
 *
 * `dns.lookup` — which the DNS layer relies on, because it must see exactly
 * what the OS resolver returns — is not async in the event-loop sense. It runs
 * getaddrinfo on a libuv worker thread, and the pool holds four of them by
 * default. With a concurrency above four, lookups queue behind each other and
 * the extra workers wait on DNS instead of probing, no matter how fast the
 * network is.
 *
 * Import this first, before anything touches the file system or DNS: the pool
 * is created on first use and the size is fixed from then on.
 */
const DEFAULT_POOL = 4;
const WANTED = 32;

if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = String(WANTED);
}

export const threadPoolSize = Number(process.env.UV_THREADPOOL_SIZE ?? DEFAULT_POOL);
