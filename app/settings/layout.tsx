import Nav from '../components/Nav';
import StatusBar from '../components/StatusBar';

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-zinc-50 dark:bg-black">
      <Nav />
      <div className="flex-1 flex flex-col">
        <StatusBar />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

