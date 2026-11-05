/** Small DOM helpers shared by the platform adapters. */

export function all(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

/** Drops elements that sit inside another element of the list (nested embeds, wrappers). */
export function outermost(els: Element[]): Element[] {
  const set = new Set(els);
  return els.filter((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
    return true;
  });
}

/** Drops elements that contain another element of the list (keeps the innermost). */
export function innermost(els: Element[]): Element[] {
  return els.filter((el) => !els.some((o) => o !== el && el.contains(o)));
}

/** Path + query of a link, resolved against the current page. */
export function linkPath(a: Element | null | undefined): string {
  const href = a?.getAttribute('href');
  if (!href) return '';
  try {
    const u = new URL(href, location.href);
    return u.pathname + u.search;
  } catch {
    return '';
  }
}

export function linkUrl(a: Element | null | undefined): URL | null {
  const href = a?.getAttribute('href');
  if (!href) return null;
  try {
    return new URL(href, location.href);
  } catch {
    return null;
  }
}

/** The first element matching `selector` inside `root` that `owner(el)` attributes to `root`. */
export function ownFirst(root: Element, selector: string, owner: (el: Element) => Element | null): Element | null {
  for (const el of all(root, selector)) if (owner(el) === root) return el;
  return null;
}

export function uniq<T>(xs: (T | null | undefined | false)[]): T[] {
  return [...new Set(xs.filter(Boolean) as T[])];
}
