// Mock of the Akamai EdgeWorkers 'cookies' module — just the surface the
// EdgeWorker uses: Cookies(header).names()/get() and SetCookie(...).toHeader().
export class Cookies {
  constructor(header) {
    this._map = new Map();
    if (header === undefined || header === null) return;
    // Akamai accepts the raw header string or the array form from getHeader().
    const raw = Array.isArray(header) ? header.join('; ') : String(header);
    for (const part of raw.split(';')) {
      const pair = part.trim();
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      this._map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  names() {
    return [...this._map.keys()];
  }

  get(name) {
    return this._map.get(name);
  }
}

export class SetCookie {
  constructor(options = {}) {
    Object.assign(this, options);
  }

  toHeader() {
    let header = `${this.name}=${this.value}`;
    if (this.path) header += `; Path=${this.path}`;
    if (typeof this.maxAge === 'number') header += `; Max-Age=${this.maxAge}`;
    if (this.domain) header += `; Domain=${this.domain}`;
    if (this.sameSite) header += `; SameSite=${this.sameSite}`;
    if (this.secure) header += '; Secure';
    if (this.httpOnly) header += '; HttpOnly';
    return header;
  }
}
