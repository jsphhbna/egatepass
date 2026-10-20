interface BrandMarkProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

const sizes = {
  sm: 'h-8 w-8',
  md: 'h-10 w-10',
  lg: 'h-14 w-14',
  xl: 'h-20 w-20',
};

export function BrandMark({ className = '', size = 'md' }: BrandMarkProps) {
  return (
    <img 
      src="/earist-logo.png" 
      alt="EARIST seal" 
      className={`object-contain rounded-full ${sizes[size]} ${className}`.trim()} 
    />
  );
}
