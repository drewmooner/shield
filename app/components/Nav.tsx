'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '../providers/AuthProvider';

export default function Nav() {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const { user, isAuthenticated, logout } = useAuth();

  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

  const links = [
    { href: '/', label: 'Dashboard' },
    { href: '/settings', label: 'Settings' },
  ];

  return (
    <>
      {/* Mobile menu button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="lg:hidden fixed top-3 right-3 z-50 p-2 bg-white/95 dark:bg-zinc-900/95 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-sm backdrop-blur"
        aria-label="Toggle menu"
      >
        <svg className="w-6 h-6 text-black dark:text-zinc-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {isOpen ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          )}
        </svg>
      </button>

      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black bg-opacity-50 z-40"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Sidebar */}
      <nav className={`bg-white dark:bg-zinc-900 border-r border-zinc-200 dark:border-zinc-800 w-64 lg:w-48 min-h-screen fixed lg:static inset-y-0 left-0 z-40 shadow-xl lg:shadow-none transform transition-transform duration-300 ease-in-out lg:translate-x-0 ${
        isOpen ? 'translate-x-0' : '-translate-x-full'
      }`}>
        <div className="p-4 pt-6 lg:pt-4">
          <div className="mb-6 flex items-center justify-between">
            <h1 className="text-xl font-bold text-black dark:text-zinc-50">Shield</h1>
            <button
              onClick={() => setIsOpen(false)}
              className="lg:hidden p-1.5 rounded-md text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              aria-label="Close menu"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <ul className="space-y-2">
            {links.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className={`block px-4 py-2 rounded-lg transition-colors ${
                    pathname === link.href
                      ? 'bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black'
                      : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                  }`}
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-6 pt-4 border-t border-zinc-200 dark:border-zinc-700">
            {isAuthenticated && user ? (
              <>
                <p className="px-4 py-1 text-sm text-zinc-500 dark:text-zinc-400 truncate" title={user.email}>
                  {user.email}
                </p>
                <button
                  onClick={() => { setIsOpen(false); logout(); }}
                  className="block w-full text-left px-4 py-2 rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                >
                  Log out
                </button>
              </>
            ) : (
              <Link
                href="/login"
                className="block px-4 py-2 rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                Log in
              </Link>
            )}
          </div>
        </div>
      </nav>
    </>
  );
}

