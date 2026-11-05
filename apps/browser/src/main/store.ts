import fs from 'node:fs';
import path from 'node:path';

/** Writes a file atomically so a crash mid-write never leaves a truncated JSON file behind. */
export function writeFileAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Debounced JSON persistence for small state files (settings, session). */
export class JsonFile<T> {
  private timer: NodeJS.Timeout | null = null;
  private pending: T | null = null;

  constructor(
    readonly file: string,
    private readonly delayMs = 300,
  ) {}

  read(): T | null {
    return readJson<T>(this.file);
  }

  write(value: T): void {
    this.pending = value;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending === null) return;
    const value = this.pending;
    this.pending = null;
    try {
      writeFileAtomic(this.file, JSON.stringify(value, null, 2));
    } catch (err) {
      console.error('Failed to write', this.file, err);
    }
  }
}
