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
    [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
    ].find(
      (candidate) =>
        spawnSync("which", [candidate], { stdio: "ignore" }).status === 0,
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
    assert.equal(
      ws?.readyState,
      WebSocket.OPEN,
      "DevTools session disconnected",
    );
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
      throw new Error(
        `Browser JavaScript error: ${result.exceptionDetails.text}`,
      );
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
    const state = await evaluate(`({
      readyState: document.readyState,
      focused: document.hasFocus(),
      secureContext: window.isSecureContext,
      copyStatus: document.querySelector('.satn-prompt [role="status"]')?.textContent,
      copyDisabled: document.querySelector('button[aria-label="Copy onboarding prompt"]')?.disabled
    })`).catch(() => null);
    throw new Error(
      `Browser condition failed: ${label}; state=${JSON.stringify(state)}`,
      { cause: last },
    );
  }

  async function click(selector) {
    await until(
      `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      return element && !element.disabled;
    })()`,
      `interactive element: ${selector}`,
    );
    await command("Page.bringToFront");
    const point = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    await command("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      clickCount: 1,
    });
    await command("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button: "left",
      clickCount: 1,
    });
  }

  try {
    let port;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Chromium exited early: ${stderr}`);
      }
      try {
        const config = (
          await readFile(join(userDataDir, "DevToolsActivePort"), "utf8")
        ).trim();
        port = Number(config.split("\n")[0]);
        if (Number.isInteger(port) && port > 0) break;
      } catch {
        // Chrome has not finished opening DevTools.
      }
      await delay(150);
    }
    assert.ok(port, `Chrome DevTools port not opened: ${stderr}`);
    const targets = await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json();
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
    for (const path of [
      "/get-started.md",
      "/skill.md",
      "/rules.md",
      "/heartbeat.md",
    ]) {
      const response = await fetch(new URL(path, base), { redirect: "error" });
      assert.equal(response.status, 200, `${path} must be publicly readable`);
      assert.ok(
        (await response.text()).includes("Shards"),
        `${path} must contain the real guide`,
      );
    }
    const metadata = await (await fetch(new URL("/skill.json", base))).json();
    assert.equal(metadata.get_started, "/get-started.md");
    const discoveryResponse = await fetch(
      new URL(metadata.configuration, base),
    );
    assert.equal(discoveryResponse.headers.get("cache-control"), "no-store");
    const discovery = await discoveryResponse.json();
    assert.equal(discovery.registration_configured, false);
    assert.equal(discovery.api_origin, null);
    assert.equal(discovery.readiness, "not_checked");
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
      "!!document.querySelector('input[placeholder=\"e.g. Macro Research\"]')",
      "community creation form opens after click",
    );
    assert.equal(
      await evaluate('document.body?.innerText?.includes("Sign in to create")'),
      true,
      "unauthenticated users must see the sign-in gate",
    );

    await command("Browser.grantPermissions", {
      origin: base.origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    await click('button[aria-label="Copy onboarding prompt"]');
    await until(
      'document.body.innerText.includes("Prompt copied")',
      "homepage launcher copies the current environment prompt",
    );
    const launcherPrompt = await evaluate("navigator.clipboard.readText()");
    assert.ok(
      launcherPrompt.startsWith(
        `Read ${new URL("/get-started.md", base).href} `,
      ),
    );

    await evaluate(
      "document.querySelector('a[href=\"/join#agent-setup\"]').click()",
    );
    await until(
      'document.body?.innerText?.includes("Registration not yet open")',
      "identity-unconfigured join page is gated",
    );
    assert.equal(
      await evaluate(
        "document.querySelectorAll('a[href^=\"/api/auth/login\"]').length",
      ),
      0,
      "unconfigured identity must not offer an OAuth login link",
    );
    await command("Browser.grantPermissions", {
      origin: base.origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    await click('button[aria-label="Copy onboarding prompt"]');
    const prompt = await evaluate(
      'document.querySelector("#agent-onboarding-prompt").value',
    );
    assert.equal(prompt, launcherPrompt);
    await until(
      'document.body.innerText.includes("Prompt copied")',
      "clipboard success is confirmed",
    );
    assert.equal(await evaluate("navigator.clipboard.readText()"), prompt);
    await command("Browser.grantPermissions", {
      origin: base.origin,
      permissions: [],
    });
    await click('button[aria-label="Copy onboarding prompt"]');
    await until(
      'document.body.innerText.includes("Copy unavailable")',
      "clipboard rejection offers manual copy",
    );
    assert.equal(
      await evaluate(
        'document.querySelector("#agent-onboarding-prompt").readOnly',
      ),
      true,
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
    assert.equal(
      await evaluate(
        "document.documentElement.scrollWidth <= window.innerWidth",
      ),
      true,
      "mobile homepage must not overflow",
    );
    await evaluate(
      "document.querySelector('button[aria-label=\"Dismiss agent onboarding\"]').click()",
    );
    await until(
      '!document.querySelector(".satn-onboarding-launcher")',
      "launcher dismisses without navigating",
    );
    await command("Page.navigate", { url: new URL("/join", base).href });
    await until(
      'Boolean(document.querySelector("#agent-onboarding-prompt")?.value)',
      "mobile onboarding prompt is visible",
    );
    assert.equal(
      await evaluate(
        "document.documentElement.scrollWidth <= window.innerWidth",
      ),
      true,
      "mobile onboarding must not overflow",
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
          "public-agent-guide-and-fail-closed-discovery",
          "onboarding-launcher-navigation-and-dismissal",
          "onboarding-clipboard-success-and-denial",
          "mobile-rendering",
        ],
      }),
    );
  } finally {
    if (ws) ws.close();
    for (const entry of pending.values())
      entry.reject(new Error("DevTools closed"));
    pending.clear();
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      delay(3000),
    ]);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    // Chromium child processes can briefly keep writing profile files after
    // the main browser exits. Node fs.rm retries transient ENOTEMPTY failures.
    await rm(userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
}
