/** Background photo downloads, so a round's photo is already on the device when it starts. */

const started = new Map<string, HTMLImageElement>(); // kept so the download isn't garbage-collected

export function preloadImage(url: string | null | undefined): void {
  if (!url || started.has(url)) return;
  const img = new Image();
  img.decoding = "async";
  img.src = url; // the server sends long cache headers, so the round's <img> reuses this download
  started.set(url, img);
}
