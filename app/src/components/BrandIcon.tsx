import type { ImgHTMLAttributes } from 'react';

export function BrandIcon(props: ImgHTMLAttributes<HTMLImageElement>) {
  return <img src={`${import.meta.env.BASE_URL}icon.png`} alt="" aria-hidden="true" draggable={false} {...props} />;
}
