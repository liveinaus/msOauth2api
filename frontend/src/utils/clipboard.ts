/**
 * Copies text, falling back to a hidden textarea.
 *
 * navigator.clipboard exists only on a secure origin, and this panel is often served over
 * plain HTTP on a LAN, so the modern API alone would leave copy silently dead for a good
 * share of installs.
 */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Permission refused or insecure origin; try the legacy path below.
  }

  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(field);
  }
}
