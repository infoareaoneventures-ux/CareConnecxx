/**
 * The care location to pre-select on the booking form: the saved address whose ZIP matches the job post (the post
 * itself carries only city/state/ZIP, never the street), else the only saved address, else the account's primary one.
 * '' when it cannot be told — the family then picks, as before.
 */
export function addressForPost(pool: Array<{ street?: string; city?: string; state?: string; zipCode?: string }>, post: { zipCode?: string } | undefined, primaryAddress: string): string {
  const full = (l: { street?: string; city?: string; state?: string; zipCode?: string }) =>
    l.street?.includes(',') ? l.street : [l.street, l.city, l.state, l.zipCode].filter(Boolean).join(', ');
  const usable = pool.filter((l) => l.street);
  const byZip = post?.zipCode ? usable.filter((l) => String(l.zipCode ?? '') === String(post.zipCode)) : [];
  if (byZip.length >= 1) return full(byZip[0]);
  if (usable.length === 1) return full(usable[0]);
  return primaryAddress || '';
}
