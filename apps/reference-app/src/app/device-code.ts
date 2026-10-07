/** The user code a device showed, carried to this page in `?device=`. See docs/specs/device-login.md. */

const USER_CODE = /^([BCDFGHJKLMNPQRSTVWXZ]{4})-?([BCDFGHJKLMNPQRSTVWXZ]{4})$/;

/** `XXXX-XXXX` from a location search string, or undefined for anything else (including two `device` parameters). */
export function deviceCodeFromSearch(search: string): string | undefined {
  const all = new URLSearchParams(search).getAll("device");
  if (all.length !== 1) return undefined;
  const m = USER_CODE.exec((all[0] as string).toUpperCase());
  return m ? `${m[1]}-${m[2]}` : undefined;
}

/** The search string without `device`, in the form `location.search` has (empty, or starting with `?`). */
export function removeDeviceParam(search: string): string {
  const p = new URLSearchParams(search);
  p.delete("device");
  const rest = p.toString();
  return rest === "" ? "" : `?${rest}`;
}
