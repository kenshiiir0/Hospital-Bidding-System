// /robots.txt: the dashboard is for the team only, so no search engine lists any page
export default function robots() {
  return { rules: { userAgent: '*', disallow: '/' } };
}
