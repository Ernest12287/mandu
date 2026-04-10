import type { RobotsFile } from '@mandujs/core'

export default function robots(): RobotsFile {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/admin', '/private'],
    },
    sitemap: 'https://example.com/sitemap.xml',
  }
}
