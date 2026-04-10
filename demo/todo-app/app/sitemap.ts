import type { Sitemap } from '@mandujs/core'

export default function sitemap(): Sitemap {
  return [
    {
      url: 'https://example.com',
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1.0,
    },
    // Add more entries here
  ]
}
