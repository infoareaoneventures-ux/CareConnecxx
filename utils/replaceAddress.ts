// Editing the care address in Settings must REPLACE the old one: the post-a-job form lists the
// address on the job record, the saved addresses and the care plan's address pool, so a stale copy
// of the old address showed up beside the new one (Santa Clara beside Gilroy).
export interface AddressLike {
  street?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  [k: string]: unknown;
}

export const addressKey = (a?: { street?: string; zipCode?: string } | null): string =>
  `${(a?.street ?? "").toLowerCase().trim()}|${a?.zipCode ?? ""}`;

/** Swap every entry that is the old address for the new one (other details like pets/smoking are kept),
 *  and drop a second copy of the new address if it was already in the list. */
export function replaceAddressInList<T extends AddressLike>(list: T[] | undefined, oldAddr: AddressLike, newAddr: AddressLike): T[] {
  if (!Array.isArray(list)) return [];
  const oldKey = addressKey(oldAddr);
  const newKey = addressKey(newAddr);
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const isOld = oldKey !== "|" && addressKey(item) === oldKey;
    const next = isOld ? ({ ...item, street: newAddr.street ?? "", city: newAddr.city ?? "", state: newAddr.state ?? "", zipCode: newAddr.zipCode ?? "" } as T) : item;
    const k = addressKey(next);
    if (isOld && k === newKey && seen.has(k)) continue;
    seen.add(k);
    out.push(next);
  }
  return out;
}
