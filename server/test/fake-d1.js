// In-memory D1 stand-in for route tests. Dispatches on the exact SQL strings
// exported as SQL from src/worker.js; unexpected SQL throws so tests catch
// queries the fake doesn't model.

import { SQL } from "../src/worker.js";

export function fakeD1() {
  const feeds = new Map(); // id -> { update_token_hash, calendar_json, expires_at, updated_at }
  const aliases = new Map(); // id -> { feed_id, feed_group }

  const first = (sql, params) => {
    switch (sql) {
      case SQL.selectFeedForRead: {
        const feed = feeds.get(params[0]);
        return feed
          ? {
              calendar_json: feed.calendar_json,
              expires_at: feed.expires_at,
              updated_at: feed.updated_at
            }
          : null;
      }
      case SQL.selectFeedForWrite: {
        const feed = feeds.get(params[0]);
        return feed
          ? {
              update_token_hash: feed.update_token_hash,
              calendar_json: feed.calendar_json,
              updated_at: feed.updated_at
            }
          : null;
      }
      case SQL.selectAlias: {
        const alias = aliases.get(params[0]);
        return alias ? { feed_id: alias.feed_id, feed_group: alias.feed_group } : null;
      }
      case SQL.countLiveFeeds: {
        let n = 0;
        for (const feed of feeds.values()) if (feed.expires_at > params[0]) n++;
        return { n };
      }
      default:
        throw new Error(`fake-d1: unexpected SQL in first(): ${sql}`);
    }
  };

  const all = (sql, params) => {
    switch (sql) {
      case SQL.selectFeedAliases:
        return [...aliases.entries()]
          .filter(([, alias]) => alias.feed_id === params[0])
          .map(([id, alias]) => ({ id, feed_group: alias.feed_group }));
      default:
        throw new Error(`fake-d1: unexpected SQL in all(): ${sql}`);
    }
  };

  const run = (sql, params) => {
    switch (sql) {
      case SQL.insertFeed:
        feeds.set(params[0], {
          update_token_hash: params[1],
          calendar_json: params[2],
          expires_at: params[3],
          updated_at: params[4]
        });
        return { success: true };
      case SQL.updateFeed: {
        const feed = feeds.get(params[3]);
        if (feed) {
          feed.calendar_json = params[0];
          feed.expires_at = params[1];
          feed.updated_at = params[2];
        }
        return { success: true };
      }
      case SQL.deleteFeed:
        feeds.delete(params[0]);
        return { success: true };
      case SQL.deleteExpiredFeeds:
        for (const [id, feed] of feeds) if (feed.expires_at <= params[0]) feeds.delete(id);
        return { success: true };
      case SQL.insertAlias:
        aliases.set(params[0], { feed_id: params[1], feed_group: params[2] });
        return { success: true };
      case SQL.deleteFeedAliases:
        for (const [id, alias] of aliases) if (alias.feed_id === params[0]) aliases.delete(id);
        return { success: true };
      case SQL.deleteOrphanAliases:
        for (const [id, alias] of aliases) if (!feeds.has(alias.feed_id)) aliases.delete(id);
        return { success: true };
      default:
        throw new Error(`fake-d1: unexpected SQL in run(): ${sql}`);
    }
  };

  return {
    feeds,
    aliases,
    prepare(sql) {
      return {
        bind: (...params) => ({
          first: () => Promise.resolve(first(sql, params)),
          all: () => Promise.resolve({ results: all(sql, params) }),
          run: () => Promise.resolve(run(sql, params))
        })
      };
    }
  };
}
