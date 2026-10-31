import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import WalletPage from "../app/wallets/page";

describe("wallet control screen", () => {
  it("separates connect, ownership proof and agent assignment", () => {
    const html = renderToStaticMarkup(createElement(WalletPage));
    expect(html).toContain("Choose a wallet");
    expect(html).toContain("Prove ownership");
    expect(html).toContain("Govern your Shards");
    expect(html).toContain("Sign in to verify");
    expect(html).toContain("PAPER ONLY");
  });
  it("never implies a connected wallet has live signing authority", () => {
    const html = renderToStaticMarkup(createElement(WalletPage));
    expect(html).toContain("EXECUTION OFF");
    expect(html).toContain("Withdrawal authority");
    expect(html).toContain("NONE");
    expect(html).not.toContain("Trade now");
  });
});
