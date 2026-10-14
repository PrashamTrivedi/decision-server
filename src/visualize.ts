import html from './visualize/index.html?raw'
import css from './visualize/style.css?raw'
import js from './visualize/app.js?raw'

/** Static shell served at GET /visualize. Holds no data; the page calls bearer-protected /v1/* endpoints. */
export const visualizeHtml = html.replace('/*STYLE*/', () => css).replace('/*SCRIPT*/', () => js)
