// README image references, shared by the npm README step, the publish guard and the smoke test.
//
// The README in the repository uses repository-relative image paths, so GitHub renders them
// from the repository itself. npm renders the README from the published package and cannot
// load images from a private repository, so the packed README points each image at the
// package's own copy through jsDelivr's npm mirror, pinned to the version being packed.

// Markdown images, <img src> and <source srcset> (the README banner's dark variant).
const IMAGE = /(!\[[^\]]*\]\()([^)\s]+)(\))|(<img\b[^>]*?\bsrc=")([^"]+)(")|(<source\b[^>]*?\bsrcset=")([^"]+)(")/g;

export const cdnPrefix = (pkg) => `https://cdn.jsdelivr.net/npm/${pkg.name}@${pkg.version}/`;

/** Every image source in the README, in order. */
export const readmeImages = (text) => [...text.matchAll(IMAGE)].map((m) => m[2] ?? m[5] ?? m[8]);

/** Rewrites every image source with `fn(src)`, leaving the rest of the README untouched. */
export const mapReadmeImages = (text, fn) =>
  text.replace(IMAGE, (...m) => {
    const [pre, src, post] = m[2] !== undefined ? [m[1], m[2], m[3]] : m[5] !== undefined ? [m[4], m[5], m[6]] : [m[7], m[8], m[9]];
    return pre + fn(src) + post;
  });

export const isRelative = (src) => !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("/") && !src.startsWith("#");

/** True when `file` (a package-relative path) is covered by package.json `files`. */
export const isShipped = (pkg, file) => pkg.files.some((f) => file === f || file.startsWith(f.replace(/\/?$/, "/")));
