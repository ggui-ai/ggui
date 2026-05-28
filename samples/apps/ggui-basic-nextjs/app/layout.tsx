import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ggui basic — Next.js',
  description:
    'Reference Next.js frontend for any MCP-Apps-spec agent backend that mounts ggui renders.',
};

export default function RootLayout({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
