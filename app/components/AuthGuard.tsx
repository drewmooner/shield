'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '../providers/AuthProvider';

const PUBLIC_PATHS = new Set(['/login', '/register']);

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { isAuthenticated, loading } = useAuth();

  const isPublicPath = PUBLIC_PATHS.has(pathname || '');
  const shouldBlock = !isPublicPath && (loading || !isAuthenticated);

  useEffect(() => {
    if (!isPublicPath && !loading && !isAuthenticated) {
      router.replace('/login');
    }
  }, [isPublicPath, loading, isAuthenticated, router]);

  if (shouldBlock) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <div className="text-center">
          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-2 border-zinc-900 border-t-transparent dark:border-zinc-50" />
          <p className="text-zinc-600 dark:text-zinc-400">Checking authentication...</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
