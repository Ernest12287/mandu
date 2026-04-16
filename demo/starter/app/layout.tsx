interface RootLayoutProps {
  children: React.ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <div
      style={{
        minHeight: "100vh",
        padding: "32px",
        background:
          "radial-gradient(circle at top left, rgba(251, 191, 36, 0.18), transparent 32%), radial-gradient(circle at top right, rgba(56, 189, 248, 0.16), transparent 28%), linear-gradient(180deg, #fff7ed 0%, #f8fafc 34%, #eef2ff 100%)",
        color: "#0f172a",
        fontFamily: "'IBM Plex Sans', 'Pretendard', system-ui, sans-serif",
      }}
    >
      {children}
    </div>
  );
}
