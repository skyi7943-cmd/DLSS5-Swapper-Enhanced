'use strict';

// Only these destinations may be opened by the renderer, never arbitrary URLs.
const links = Object.freeze({
  github: 'https://github.com/skyi7943-cmd/DLSS5-Swapper-Enhanced',
  releases: 'https://github.com/skyi7943-cmd/DLSS5-Swapper-Enhanced/releases/latest',
  coffee: 'https://github.com/skyi7943-cmd/DLSS5-Swapper-Enhanced'
});
function projectUrl(key) {
  return typeof key === 'string' && Object.hasOwn(links, key) ? links[key] : null;
}
module.exports = { links, projectUrl };
