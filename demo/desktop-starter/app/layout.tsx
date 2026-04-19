interface RootLayoutProps {
  children: React.ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <div
      style={{
        minHeight: "100vh",
        padding: "48px",
        background:
          "linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #334155 100%)",
        color: "#f1f5f9",
        fontFamily:
          "'IBM Plex Sans', 'Pretendard', system-ui, -apple-system, sans-serif",
      }}
    >
      {children}
    </div>
  );
}
