import type { ReactNode } from "react";

export const metadata = {
  title: "next-bun-cache-handler example",
  description: "Bun-native cache handler for Next.js Cache Components",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          maxWidth: 640,
          margin: "4rem auto",
          padding: "0 1rem",
          lineHeight: 1.6,
        }}
      >
        {children}
      </body>
    </html>
  );
}
