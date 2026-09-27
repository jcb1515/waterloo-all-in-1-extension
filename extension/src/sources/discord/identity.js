// @ts-check
// Self/role id inference from the /users/@me/mentions endpoint. The only
// Discord ids this adapter ever stores are the user's own — author ids are
// compared and discarded, never persisted. Pure.

/**
 * Update identity inference from a mentions-endpoint message list.
 * - A mentions message with no @everyone and no role mentions must ping the
 *   user directly: intersect every such message's `mentions[].id` sets;
 *   exactly one survivor => selfId.
 * - Once selfId is known, a mentions message that doesn't mention it and
 *   isn't @everyone is a role ping of the user: a single `mention_roles`
 *   entry => that role is ours.
 * @param {{selfId?: string, roleIds?: string[], evidence?: number}|undefined} prev
 * @param {any[]} messages  normalizeRestBody(mentions).messages
 * @param {{userId?: string, roleIds?: string[]}} [settings]
 * @returns {{selfId?: string, roleIds: string[], evidence: number}}
 */
const arr = (v) => (Array.isArray(v) ? v : []);

export function inferIdentity(prev, messages, settings) {
  const msgs = arr(messages);
  const out = {
    selfId: prev?.selfId,
    roleIds: [...new Set(arr(prev?.roleIds))],
    evidence: (Number(prev?.evidence) || 0) + msgs.length,
  };
  if (settings?.userId) out.selfId = String(settings.userId);
  for (const r of arr(settings?.roleIds)) {
    if (!out.roleIds.includes(String(r))) out.roleIds.push(String(r));
  }

  // Direct pings narrow the self-id candidate set.
  const directs = msgs.filter(
    (m) =>
      m &&
      !m.mention_everyone &&
      !(Array.isArray(m.mention_roles) && m.mention_roles.length) &&
      Array.isArray(m.mentions) &&
      m.mentions.length
  );
  if (!out.selfId && directs.length) {
    /** @type {Set<string>|null} */
    let inter = null;
    for (const m of directs) {
      /** @type {Set<string>} */
      const ids = new Set(
        (m.mentions || []).map((u) => String(u?.id)).filter(Boolean)
      );
      if (inter === null) {
        inter = ids;
      } else {
        for (const id of [...inter]) if (!ids.has(id)) inter.delete(id);
      }
      if (inter.size === 0) break;
    }
    if (inter && inter.size === 1) out.selfId = [...inter][0];
  }

  // Role pings: mentions-endpoint messages that reach the user through a
  // single role.
  if (out.selfId) {
    for (const m of msgs) {
      if (!m || m.mention_everyone) continue;
      const mentions = Array.isArray(m.mentions) ? m.mentions : [];
      if (mentions.some((u) => String(u?.id) === out.selfId)) continue;
      const roles = Array.isArray(m.mention_roles) ? m.mention_roles : [];
      if (roles.length === 1 && !out.roleIds.includes(String(roles[0]))) {
        out.roleIds.push(String(roles[0]));
      }
    }
  }
  return out;
}
