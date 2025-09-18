import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

export default function DeveloperLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {

  const userId = 

  return (
    <div>
      <h1>I am developer</h1>
      {children}
      {<ReactQueryDevtools initialIsOpen={false} />}
    </div>
  );
}
