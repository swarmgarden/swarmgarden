// Swarm Garden — referrer grouping for the steward stats pages
// (B1 proposal §5, approved Oct 18 2026). ONE shared map, both pages:
// a display-layer fold over the host counts aggregateVisits already
// returns. The raw host is always printed beside the grouped name —
// grouping is a reading aid, never a replacement for the record.
//
// Honesty rules that travel with this table (they are printed on the
// pages with it):
//   - The referer is a claim sent by the browser. It is often absent
//     or stripped — social apps and in-app browsers frequently send
//     none, or only a generic shim host.
//   - Platform figures are a LOWER BOUND.
//   - The empty bucket is titled "No referer recorded" — never
//     "direct", never "typed the address". (The hourly snapshot log's
//     old "(none — direct)" label was corrected to the same wording
//     in the same build.)
//   - The no-referer figure is computed as total visits minus the sum
//     of grouped referrer hosts; the residual also absorbs the rare
//     unparseable referer, and the line is labelled accordingly.
// Mastodon and other federated hosts are deliberately NOT grouped:
// there is no single shim host, so each instance host prints raw
// rather than being guessed into a platform.
export const REFERRER_GROUPS = [
  ['X', ['t.co', 'x.com', 'twitter.com']],
  ['Facebook', ['l.facebook.com', 'lm.facebook.com', 'facebook.com', 'm.facebook.com']],
  ['Instagram', ['instagram.com', 'l.instagram.com']],
  ['LinkedIn', ['linkedin.com', 'lnkd.in']],
  ['Reddit', ['reddit.com', 'old.reddit.com', 'out.reddit.com']],
  ['Hacker News', ['news.ycombinator.com']],
  ['Bluesky', ['bsky.app']],
  ['YouTube', ['youtube.com', 'youtu.be']]
];

function groupForHost(host) {
  for (const [name, hosts] of REFERRER_GROUPS) if (hosts.includes(host)) return name;
  if (/^([a-z0-9-]+\.)*google\.[a-z.]+$/.test(host)) return 'Google (search)'; // google.* hosts
  return null;
}

// groupReferrers(byRefHosts, totalVisits) ->
//   { grouped: [{ name, count, hosts: [[host, count], ...] }, ...]
//     sorted largest first (unmapped hosts appear under their own
//     raw host name with a single-host list),
//     no_referer_recorded: totalVisits - sum(grouped counts) }
export function groupReferrers(byRefHosts, totalVisits) {
  const groups = new Map();
  for (const [host, count] of Object.entries(byRefHosts || {})) {
    const name = groupForHost(host) || host;
    if (!groups.has(name)) groups.set(name, { name, count: 0, hosts: [] });
    const g = groups.get(name);
    g.count += count;
    g.hosts.push([host, count]);
  }
  const grouped = [...groups.values()]
    .map(g => ({ ...g, hosts: g.hosts.sort((a, b) => b[1] - a[1]) }))
    .sort((a, b) => b.count - a.count);
  const accounted = grouped.reduce((a, g) => a + g.count, 0);
  return { grouped, no_referer_recorded: Math.max(0, (totalVisits || 0) - accounted) };
}
