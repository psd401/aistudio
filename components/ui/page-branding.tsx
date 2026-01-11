import Image from 'next/image';

export function PageBranding() {
  return (
    <div className="flex items-center gap-2 mb-1">
      <Image src="/logo.png" alt="" width={20} height={20} className="opacity-70" />
      <span className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
        Peninsula School District - AI Studio
      </span>
    </div>
  );
}
