'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function Nav() {
  const pathname = usePathname();

  const links = [
    { href: '/', label: 'Dashboard' },
    { href: '/settings', label: 'Settings' },
  ];

  return (
    <nav className="bg-white dark:bg-zinc-900 border-r border-zinc-200 dark:border-zinc-800 w-48 min-h-screen">
      <div className="p-4">
        <h1 className="text-xl font-bold mb-6 text-black dark:text-zinc-50">Shield</h1>
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
      </div>
    </nav>
  );
}

