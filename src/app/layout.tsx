import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import Layout from '@/components/Layout/Layout';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: {
    default: 'Tawazun Books | Finance Management System',
    template: '%s | Tawazun Books',
  },
  description:
    'Tawazun Books is a modern finance management system that helps individuals and businesses track expenses, manage budgets, generate insightful reports, and stay in control of financial goals with ease and efficiency.',
  keywords: [
    'finance management',
    'expense tracker',
    'budget management',
    'business finance',
    'personal finance',
    'Tawazun Books',
    'financial reports',
    'money management',
    'accounting software',
  ],
  authors: [{ name: 'Zebotix Team' }],
  creator: 'Muhammad Zeeshan Khan',
  publisher: 'Tawazun Books',
  metadataBase: new URL('https://tawazunbooks.com'), // ✅ update with your domain
  robots: {
    index: true,
    follow: true,
    nocache: false,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  alternates: {
    canonical: 'https://tawazunbooks.com',
  },
  openGraph: {
    title: 'Tawazun Books | Finance Management System',
    description:
      'All-in-one solution for tracking expenses, managing budgets, and generating reports. Perfect for both individuals and businesses.',
    url: 'https://tawazunbooks.com',
    siteName: 'Tawazun Books',
    images: [
      {
        url: '/logo.png', // ✅ add this image in public/
        width: 1200,
        height: 630,
        alt: 'Tawazun Books Finance Dashboard',
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Tawazun Books | Finance Management System',
    description: 'Track your expenses, manage budgets, and generate reports with Tawazun Books.',
    creator: '@tawazunbooks', // ✅ update with your X handle
    images: ['/logo.png'],
  },
  icons: {
    icon: '/logo.png',
    shortcut: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
  category: 'Finance',
  other: {
    copyright: '© 2025 Tawazun Books. All rights reserved.',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang='en' suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        suppressHydrationWarning
      >
        <Layout>{children}</Layout>
      </body>
    </html>
  );
}
