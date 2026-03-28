# Dashboard LAN Access Investigation

Date: 2026-03-27

## Summary

The dashboard does not currently work when accessed from a LAN IP such as `http://10.0.2.110:4848` for three separate reasons:

1. The dashboard frontend hardcodes `localhost` for several HTTP and WebSocket calls.
2. The standalone dashboard server binds to `127.0.0.1`, not `0.0.0.0`.
3. Each per-session stream server also binds to `127.0.0.1`, and its WebSocket origin check only allows loopback origins.

Changing only the frontend URLs is not sufficient. The session stream server must also be reachable from the LAN browser, and it must accept the LAN dashboard origin.

## 1. All dashboard files with hardcoded localhost

### Functional localhost references

#### `packages/dashboard/src/store/sessions.ts`

Line 27:

```ts
return `http://localhost:${DASHBOARD_PORT}/api/sessions`;
```

Issue:
- This is used when the dashboard is not already being served from port `4848`.
- For LAN access, this forces requests back to the browser device's own localhost instead of the machine running `agent-browser`.

Recommended change:
- Build the URL from `window.location.hostname` instead of `localhost`.
- Keep the path relative when already on the dashboard origin.

Line 226:

```ts
`http://localhost:${s.port}/api/tabs`,
```

Issue:
- This polls each session's stream server directly.
- From a LAN device, `localhost:${s.port}` points to the client device, not the server machine.

Recommended change:
- Use the current browser hostname:

```ts
`${window.location.protocol}//${window.location.hostname}:${s.port}/api/tabs`
```

For plain HTTP that will resolve to `http://10.0.2.110:${s.port}/api/tabs`.

#### `packages/dashboard/src/store/stream.ts`

Line 122:

```ts
const ws = new WebSocket(`ws://localhost:${port}`);
```

Issue:
- This is the live stream connection to each session stream server.
- On a LAN device, this tries to open a socket to the client device's localhost.

Recommended change:
- Use the current hostname, and ideally derive `ws` vs `wss` from `window.location.protocol`.

Example:

```ts
const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const ws = new WebSocket(`${wsProtocol}//${window.location.hostname}:${port}`);
```

#### `packages/dashboard/src/lib/exec.ts`

Line 12:

```ts
const resp = await fetch(`http://localhost:${DASHBOARD_PORT}/api/exec`, {
```

Line 34:

```ts
const resp = await fetch(`http://localhost:${DASHBOARD_PORT}/api/kill`, {
```

Issue:
- These API calls are sent to the standalone dashboard server on port `4848`.
- From a LAN device, the requests go to the client device instead of the server.

Recommended change:
- Use a same-origin relative path when the dashboard page is already loaded from the dashboard server.
- Otherwise build the URL from `window.location.hostname`.

### UI-only localhost references in dashboard source

These are not the primary networking failures, but they are still hardcoded localhost references in the dashboard source.

#### `packages/dashboard/src/components/viewport.tsx`

Line 553:

```tsx
ws://localhost:{streamPort}
```

Issue:
- Display-only label.
- Misleading when the dashboard is accessed over a LAN hostname.

Recommended change:
- Render the current hostname instead of the literal `localhost`.

#### `packages/dashboard/src/components/session-tree.tsx`

Line 83:

```ts
if (!hostname || hostname === "localhost") return null;
```

Issue:
- This is favicon logic, not the dashboard transport path.
- It is not a LAN blocker.

Recommended change:
- No change is strictly required for LAN support.
- Only adjust if you want localhost aliases such as `127.0.0.1` or the active dashboard hostname treated consistently in the UI.

## 2. Exact server-side lines/code that need changing

### Standalone dashboard server bind

#### `cli/src/native/stream.rs`

Lines 1482-1484:

```rust
pub async fn run_dashboard_server(port: u16) {
    let addr = format!("127.0.0.1:{}", port);
    let listener = match TcpListener::bind(&addr).await {
```

Result:
- The dashboard server only listens on loopback.
- `http://10.0.2.110:4848` will not connect from another device.

Needed change:
- Bind to `0.0.0.0` for LAN access, or make host configurable via a `--host` flag and pass it through to this function.

### Per-session stream server bind

#### `cli/src/native/stream.rs`

Lines 166-170:

```rust
let addr = format!("127.0.0.1:{}", preferred_port);
let listener = match TcpListener::bind(&addr).await {
    Ok(l) => l,
    Err(_) if allow_port_fallback && preferred_port != 0 => {
        TcpListener::bind("127.0.0.1:0")
```

Result:
- Each session stream server only listens on loopback.
- Even if the dashboard on `4848` is made reachable over LAN, the dashboard's WebSocket connection and `/api/tabs` polling to `10.0.2.110:<session-port>` will still fail.

Needed change:
- Bind session stream servers to `0.0.0.0`, or make the bind host configurable and use the same host value for both dashboard and session stream listeners.

### WebSocket origin allowlist

#### `cli/src/native/stream.rs`

Lines 1417-1426:

```rust
pub fn is_allowed_origin(origin: Option<&str>) -> bool {
    match origin {
        None => true,
        Some(o) => {
            if o.starts_with("file://") {
                return true;
            }
            if let Ok(url) = url::Url::parse(o) {
                let host = url.host_str().unwrap_or("");
                host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
```

Result:
- A browser visiting `http://10.0.2.110:4848` will send `Origin: http://10.0.2.110:4848` for the session WebSocket.
- That origin is rejected even if the stream server is rebound to `0.0.0.0`.

Needed change:
- Allow the configured dashboard host, or make origin validation compare against the dashboard host/bind host rather than hardcoded loopback names.

### CLI startup output

#### `cli/src/main.rs`

Line 237:

```rust
println!("Dashboard already running at http://localhost:{}", port);
```

Line 305:

```rust
println!("Dashboard started at http://localhost:{}", port);
```

Result:
- These are output strings only.
- They do not control binding, but they will be wrong once LAN hosting is supported.

Needed change:
- Print the configured host, or print a host-agnostic message.

### CLI dashboard startup path

#### `cli/src/main.rs`

Lines 503-509:

```rust
if env::var("AGENT_BROWSER_DASHBOARD").is_ok() {
    let port: u16 = env::var("AGENT_BROWSER_DASHBOARD_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(4848);
    let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
    rt.block_on(native::stream::run_dashboard_server(port));
```

Result:
- Only the port is passed into the background dashboard process.
- There is no host parameter today.

Needed change:
- Add host plumbing if LAN support should be configurable.

## 3. Whether the server binds to localhost or 0.0.0.0

### Standalone dashboard server

- Current behavior: binds to `127.0.0.1`
- Source: `cli/src/native/stream.rs:1483`

### Per-session stream server

- Current behavior: binds to `127.0.0.1`
- Source: `cli/src/native/stream.rs:166`, `cli/src/native/stream.rs:170`

### Conclusion

The server side is currently loopback-only, not `0.0.0.0`.

If the goal is LAN access, both the standalone dashboard server and the per-session stream servers need host changes. The standalone `dashboard start` path alone is not enough because the dashboard frontend connects directly to per-session ports for streaming and tab polling.

## 4. Recommended patch plan

### Frontend

1. Add a small shared URL helper in `packages/dashboard/src/lib/` that derives host/protocol from `window.location`.
2. Replace all functional `localhost` URL construction in:
   - `packages/dashboard/src/store/sessions.ts`
   - `packages/dashboard/src/store/stream.ts`
   - `packages/dashboard/src/lib/exec.ts`
3. Keep same-origin relative URLs for dashboard APIs when the page is already loaded from the dashboard server.
4. Update the display-only `ws://localhost:{streamPort}` label in `packages/dashboard/src/components/viewport.tsx`.

Recommended helper behavior:
- HTTP base: `${window.location.protocol}//${window.location.hostname}:${port}`
- WS base: `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.hostname}:${port}`

### Backend

1. Add a dashboard host concept in the CLI, preferably `agent-browser dashboard start --host <host>`.
2. Pass that host into the background dashboard process, similar to how port is passed today.
3. Update `run_dashboard_server` to bind to the configured host instead of hardcoded `127.0.0.1`.
4. Update the per-session stream server bind path to use the same configured host, or another explicitly configured stream host.
5. Update the WebSocket origin allowlist in `is_allowed_origin` so it accepts the configured dashboard host.
6. Update startup messages in `cli/src/main.rs` so they do not hardcode `http://localhost`.

### Minimal viable behavior

If the intention is "dashboard works from a LAN IP without extra flags", the minimal effective backend behavior is:

1. Dashboard server binds `0.0.0.0`.
2. Session stream servers bind `0.0.0.0`.
3. WebSocket origin validation allows the LAN dashboard host.
4. Frontend uses `window.location.hostname` instead of `localhost`.

### Better long-term behavior

Prefer a configurable host rather than unconditional `0.0.0.0`:

1. Default host could remain safe/local by policy if desired.
2. `--host 0.0.0.0` can explicitly enable LAN access.
3. The same host value can drive:
   - bind address
   - printed dashboard URL
   - allowed WebSocket origin host

## Bottom line

The dashboard frontend has multiple hardcoded `localhost` references, but the LAN issue is not just frontend code. The current backend is also loopback-only, and the session WebSocket origin check is loopback-only. A complete fix requires both:

- frontend URL construction from `window.location.hostname`
- server-side host/origin changes in `cli/src/native/stream.rs` and host plumbing from `cli/src/main.rs`
