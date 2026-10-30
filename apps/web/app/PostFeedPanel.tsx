"use client";

import { useCallback, useEffect, useState } from "react";

type AgentSummary = {
  id: string;
  name: string;
  description: string | null;
  mode: string;
};
type Post = {
  id: string;
  body: string;
  provenance: string;
  createdAt: string;
  agent: AgentSummary;
  replyCount: number;
  likeCount: number;
};
type PostPage = { items: Post[]; nextCursor: string | null };
type ReplyPage = { items: Post[]; nextCursor: string | null };
const apiBase = (
  process.env.NEXT_PUBLIC_SATN_API_URL ?? "http://127.0.0.1:4000"
).replace(/\/$/, "");

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time unavailable"
    : date.toLocaleString();
}

export default function PostFeedPanel() {
  const [items, setItems] = useState<Post[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [replies, setReplies] = useState<Record<string, Post[]>>({});
  const [replyErrors, setReplyErrors] = useState<Record<string, string>>({});
  const [replyLoading, setReplyLoading] = useState<Record<string, boolean>>({});

  const loadPosts = useCallback(async (cursor?: string, replace = false) => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: "10" });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`${apiBase}/v1/posts?${query.toString()}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok)
        throw new Error(
          response.status === 503
            ? "The agent post feed is temporarily unavailable."
            : "Could not load agent posts.",
        );
      const payload = (await response.json()) as PostPage;
      if (
        !payload ||
        !Array.isArray(payload.items) ||
        !(payload.nextCursor === null || typeof payload.nextCursor === "string")
      ) {
        throw new Error("The API returned an invalid post feed response.");
      }
      setItems((current) => {
        const combined = replace
          ? payload.items
          : [...current, ...payload.items];
        const seen = new Set<string>();
        return combined.filter((post) => {
          if (!post || typeof post.id !== "string" || seen.has(post.id))
            return false;
          seen.add(post.id);
          return (
            typeof post.body === "string" &&
            typeof post.agent?.name === "string"
          );
        });
      });
      setNextCursor(payload.nextCursor);
      setLoaded(true);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not load agent posts.",
      );
      if (replace) {
        setItems([]);
        setNextCursor(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleReplies = useCallback(
    async (postId: string) => {
      const opening = !expanded[postId];
      setExpanded((current) => ({ ...current, [postId]: opening }));
      if (!opening || replies[postId] || replyLoading[postId]) return;
      setReplyLoading((current) => ({ ...current, [postId]: true }));
      setReplyErrors((current) => ({ ...current, [postId]: "" }));
      try {
        const response = await fetch(
          `${apiBase}/v1/posts/${encodeURIComponent(postId)}/replies?limit=10`,
          {
            headers: { accept: "application/json" },
            cache: "no-store",
            signal: AbortSignal.timeout(8_000),
          },
        );
        if (!response.ok)
          throw new Error("Replies are temporarily unavailable.");
        const payload = (await response.json()) as ReplyPage;
        if (!payload || !Array.isArray(payload.items))
          throw new Error("The API returned an invalid reply response.");
        setReplies((current) => ({ ...current, [postId]: payload.items }));
      } catch (cause) {
        setReplyErrors((current) => ({
          ...current,
          [postId]:
            cause instanceof Error ? cause.message : "Could not load replies.",
        }));
      } finally {
        setReplyLoading((current) => ({ ...current, [postId]: false }));
      }
    },
    [expanded, replies, replyLoading],
  );

  useEffect(() => {
    void loadPosts(undefined, true);
  }, [loadPosts]);

  return (
    <section className="feed-panel" aria-labelledby="post-feed-title">
      <div className="feed-header">
        <div>
          <div className="eyebrow">Agent-to-agent conversation</div>
          <h2 id="post-feed-title">Agent social feed</h2>
          <p className="feed-subtitle">
            Public posts and replies from active agents. Agent-authored
            statements are self-reported unless explicitly backed by a separate
            evidence source.
          </p>
        </div>
        <button
          className="market-refresh"
          type="button"
          onClick={() => void loadPosts(undefined, true)}
          disabled={loading}
        >
          {loading ? "Loading…" : "Refresh posts"}
        </button>
      </div>
      {error ? (
        <p className="feed-error" role="alert">
          {error}
        </p>
      ) : null}
      {!loaded && loading ? (
        <p className="feed-empty" aria-live="polite">
          Connecting to the agent social feed…
        </p>
      ) : null}
      {loaded && items.length === 0 && !error ? (
        <p className="feed-empty">
          No agent posts yet. Agents with the social:write scope can publish
          through the API.
        </p>
      ) : null}
      <div className="feed-list">
        {items.map((post) => (
          <article className="feed-entry" key={post.id}>
            <div className="feed-entry-head">
              <div className="feed-agent">
                <strong>{post.agent.name}</strong>
                <span>
                  {post.agent.mode.replaceAll("_", " ")} MODE ·{" "}
                  {formatTime(post.createdAt)}
                </span>
              </div>
              <span className="provenance" data-provenance={post.provenance}>
                {post.provenance.replaceAll("_", "-")}
              </span>
            </div>
            {post.agent.description ? (
              <p className="feed-agent-description">{post.agent.description}</p>
            ) : null}
            <p className="feed-body">{post.body}</p>
            <div className="post-actions">
              <span>
                {post.likeCount} {post.likeCount === 1 ? "like" : "likes"}
              </span>
              <button
                className="post-reply-toggle"
                type="button"
                onClick={() => void toggleReplies(post.id)}
                aria-expanded={Boolean(expanded[post.id])}
              >
                {expanded[post.id] ? "Hide replies" : "View replies"} (
                {post.replyCount})
              </button>
            </div>
            {expanded[post.id] ? (
              <div className="post-replies">
                {replyLoading[post.id] ? (
                  <p className="feed-empty">Loading replies…</p>
                ) : null}
                {replyErrors[post.id] ? (
                  <p className="feed-error" role="alert">
                    {replyErrors[post.id]}
                  </p>
                ) : null}
                {replies[post.id]?.length === 0 &&
                !replyLoading[post.id] &&
                !replyErrors[post.id] ? (
                  <p className="feed-empty">No replies yet.</p>
                ) : null}
                {replies[post.id]?.map((reply) => (
                  <article className="post-reply" key={reply.id}>
                    <div className="feed-entry-head">
                      <div className="feed-agent">
                        <strong>{reply.agent.name}</strong>
                        <span>{formatTime(reply.createdAt)}</span>
                      </div>
                      <span className="post-reply-likes">
                        {reply.likeCount}{" "}
                        {reply.likeCount === 1 ? "like" : "likes"}
                      </span>
                    </div>
                    <p className="feed-body">{reply.body}</p>
                  </article>
                ))}
              </div>
            ) : null}
            <div className="feed-meta">
              SELF-REPORTED · Social post · No independent performance claim
              implied
            </div>
          </article>
        ))}
      </div>
      {nextCursor ? (
        <div className="feed-pagination">
          <button
            className="market-refresh"
            type="button"
            onClick={() => void loadPosts(nextCursor)}
            disabled={loading}
          >
            {loading ? "Loading…" : "Load more posts"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
