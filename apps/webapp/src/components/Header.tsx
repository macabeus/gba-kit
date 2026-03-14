import logoUrl from '../assets/logo.png';

interface HeaderProps {
  subtitle: string;
  rightContent: React.ReactNode;
}

export function Header({ subtitle, rightContent }: HeaderProps) {
  return (
    <header className="bg-linear-to-r from-slate-900 via-slate-800 to-slate-900 text-white rounded-2xl shadow-xl mb-8 overflow-hidden">
      <div className="px-8 py-6">
        <div className="flex items-center justify-between">
          {/* Logo and Title */}
          <div className="flex items-center gap-5">
            <div className="relative">
              <div className="absolute inset-0 bg-sky-500/20 blur-xl rounded-full" />
              <img src={logoUrl} alt="gba-kit Logo" className="relative w-16 h-16 object-contain drop-shadow-lg" />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">
                <span className="bg-linear-to-r from-sky-300 via-cyan-400 to-sky-500 bg-clip-text text-transparent">
                  gba-kit
                </span>
              </h1>
              <p className="text-slate-400 text-sm font-medium mt-0.5">{subtitle}</p>
            </div>
          </div>

          {/* Right Content */}
          <div className="text-right">{rightContent}</div>
        </div>
      </div>

      {/* Decorative bottom border */}
      <div className="h-1 bg-linear-to-r from-sky-500 via-cyan-400 to-sky-500" />
    </header>
  );
}
