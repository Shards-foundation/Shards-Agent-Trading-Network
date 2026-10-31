import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Real Chromium browser smoke with native Node 22 WebSocket/CDP.
 * NO fake posts, tokens, database content or browser API substitutions.
 * The backing Fastify API and disposable database are managed by fullstack-e2e.
 * Public network BFF remains fail-closed without an HTTPS upstream.
 */
export async function runBrowserSmoke(webOrigin) {
  const base = new URL(webOrigin);
  assert.equal(base.protocol, "http:");
  assert.ok(["localhost", "127.0.0.1"].includes(base.hostname));
  assert.ok(!base.username && !base.password);

  const chrome =
    process.env.CHROME_BIN ??
    ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find(
      (candidate) => spawnSync("which", [candidate], { stdio: "ignore" }).status === 0,
    );
  assert.ok(chrome, "Chromium/Chrome executable required for browser E2E");

  const userDataDir = await mkdtemp(join(tmpdir(), "satns-browser-"));
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (part) => {
    stderr = (stderr + String(part)).slice(-2500);
  });
  let ws;
  let seq = 0;
  const pending = new Map();

  async function command(method, params = {}) {
    assert.equal(ws?.readyState, WebSocket.OPEN, "DevTools session disconnected");
    const id = ++seq;
    return new Promise((resolveResult, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`DevTools ${method} timed out`));
      }, 10_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolveResult(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const result = await command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`Browser JavaScript error: ${result.exceptionDetails.text}`);
    }
    return result.result?.value;
  }

  async function until(expression, label, timeoutMs = 18_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        const value = await evaluate(expression);
        if (value) return value;
      } catch (error) {
        last = error;
      }
      await delay(200);
    }
    throw new Error(`Browser condition failed: ${label}`, { cause: last });
  }

  try {
    let port;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Chromium exited early: ${stderr}`);
      }
      try {
        const config = (await readFile(join(userDataDir, "DevToolsActivePort"), "utf8")).trim();
        port = Number(config.split("\n")[0]);
        if (Number.isInteger(port) && port > 0) break;
      } catch {
        // Chrome has not finished opening DevTools.
      }
      await delay(150);
    }
    assert.ok(port, `Chrome DevTools port not opened: ${stderr}`);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((target) => target.type === "page");
    assert.ok(page?.webSocketDebuggerUrl, "Chrome page target unavailable");
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolveReady, reject) => {
      ws.addEventListener("open", resolveReady, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    ws.addEventListener("message", (event) => {
      let packet;
      try {
        packet = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const entry = pending.get(packet.id);
      if (!entry) return;
      pending.delete(packet.id);
      if (packet.error) entry.reject(new Error(packet.error.message));
      else entry.resolve(packet.result ?? {});
    });

    await command("Page.enable");
    await command("Runtime.enable");
    await command("Page.navigate", { url: base.href });
    await until(
      'document.body?.innerText?.includes("LIVE EXECUTION DISABLED")',
      "page renders its paper-only safety boundary",
    );
    await until(
      'document.body?.innerText?.includes("Feed unavailable")',
      "hydrated feed reports real unavailable service",
    );
    const state = await evaluate(
      `({
        statsUnavailable: document.body.innerText.includes("AWAITING DATA"),
        noMockPosts: document.querySelectorAll(".satn-post").length === 0,
        noFabricatedCounts: !document.querySelector(".satn-stat-bottom .live"),
        retryButton: [...document.querySelectorAll("button")].some(b => b.innerText.includes("Retry feed")),
        errorVisible: document.body.innerText.includes("Counts and communities remain unverified.")
      })`,
    );
    assert.deepEqual(state, {
      statsUnavailable: true,
      noMockPosts: true,
      noFabricatedCounts: true,
      retryButton: true,
      errorVisible: true,
    });

    const clicked = await evaluate(
      `(() => {
        const retry = [...document.querySelectorAll("button")].find(b => b.innerText.includes("Retry feed"));
        if (!retry) return false;
        retry.click();
        return true;
      })()`,
    );
    assert.equal(clicked, true, "retry button must be clickable");
    await until(
      'document.body?.innerText?.includes("Feed unavailable")',
      "retry remains fail-closed without backend",
    );

    assert.equal(
      await evaluate(`(() => {
        const trigger = document.querySelector('button[aria-label="Create community"]');
        if (!trigger) return false;
        trigger.click();
        return true;
      })()`),
      true,
      "create-community button should be clickable",
    );
    await until(
      '!!document.querySelector(\'input[placeholder="e.g. Macro Research"]\')',
      "community creation form opens after click",
    );
    assert.equal(
      await evaluate('document.body?.innerText?.includes("Sign in to create")'),
      true,
      "unauthenticated users must see the sign-in gate",
    );

    await command("Page.navigate", { url: new URL("/join", base).href });
    await until(
      'document.body?.innerText?.includes("Registration not yet open")',
      "identity-unconfigured join page is gated",
    );
    assert.equal(
      await evaluate('document.querySelectorAll(\'a[href^="/api/auth/login"]\').length'),
      0,
      "unconfigured identity must not offer an OAuth login link",
    );

    await command("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await command("Page.navigate", { url: base.href });
    await until(
      'document.body?.innerText?.includes("LIVE EXECUTION DISABLED")',
      "mobile viewport renders the safety notice",
    );

    console.info(
      JSON.stringify({
        event: "e2e.browser.passed",
        engine: "chromium-cdp",
        scenarios: [
          "hydrated-paper-only-homepage",
          "backend-unavailable-without-fabricated-posts",
          "network-stats-fail-closed",
          "feed-retry-interaction",
          "unauthenticated-community-form-gated",
          "unconfigured-human-registration-gated",
          "mobile-rendering",
        ],
      }),
    );
  } finally {
    if (ws) ws.close();
    for (const entry of pending.values()) entry.reject(new Error("DevTools closed"));
    pending.clear();
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      delay(3000),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(userDataDir, { recursive: true, force: true });
  }
}
