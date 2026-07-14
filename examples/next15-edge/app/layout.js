export const metadata = { title: 'CSP Next 15 Edge' }

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui', padding: 24 }}>{children}</body>
    </html>
  )
}
