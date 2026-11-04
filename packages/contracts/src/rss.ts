export interface RssFeed {
  id: string
  /** display name; empty = use the title advertised by the feed itself */
  title: string
  url: string
  enabled: boolean
  createdAt: number
}

export interface RssItem {
  id: string
  feedId: string
  feedTitle: string
  title: string
  link: string
  publishedAt: number
  summary: string
}
