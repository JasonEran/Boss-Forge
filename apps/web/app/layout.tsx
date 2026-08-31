import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Boss Forge · HR 招聘工作台',
  description: '用于候选人筛选、人工审核与受控联系的内网 HR 工作台。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
