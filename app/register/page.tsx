'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '../providers/AuthProvider';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function RegisterPage() {
  const { register, isAuthenticated, loading } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && isAuthenticated) router.replace('/');
  }, [loading, isAuthenticated, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setSubmitting(true);
    try {
      await register(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-zinc-900 dark:border-zinc-50 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black p-4">
      <div className="w-full max-w-md">
        <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-lg p-8 border border-zinc-200 dark:border-zinc-800">
          <h1 className="text-2xl font-semibold text-center text-zinc-900 dark:text-zinc-50 mb-2">
            Create account
          </h1>
          <p className="text-center text-zinc-500 dark:text-zinc-400 text-sm mb-6">
            Sign up for your personal Shield bot
          </p>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-50 focus:border-transparent"
                placeholder="you@example.com"
                required
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-50 focus:border-transparent"
                placeholder="At least 8 characters"
                required
                minLength={8}
              />
            </div>
            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                Confirm password
              </label>
              <input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-50 focus:border-transparent"
                placeholder="Same as above"
                required
              />
            </div>
            <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-3 text-sm text-amber-800 dark:text-amber-200">
              <strong>Save your password.</strong> It cannot be recovered or reset. If you lose it, you&apos;ll need to disconnect WhatsApp and create a new account.
            </div>
            {error && (
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            )}
            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 rounded-lg bg-zinc-900 dark:bg-zinc-50 text-white dark:text-zinc-900 font-medium hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors disabled:opacity-50"
            >
              {submitting ? 'Creating account…' : 'Create account'}
            </button>
          </form>
          <p className="mt-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
            Already have an account?{' '}
            <Link href="/login" className="text-zinc-900 dark:text-zinc-50 font-medium hover:underline">
              Sign in
            </Link>
          </p>
          <p className="mt-4 text-center">
            <Link href="/" className="text-sm text-zinc-500 dark:text-zinc-400 hover:underline">
              ← Back to app
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
