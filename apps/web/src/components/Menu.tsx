import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ComponentProps, ReactNode } from 'react';

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export function MenuContent({ children, ...props }: ComponentProps<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="menu" sideOffset={6} collisionPadding={8} {...props}>
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

interface ItemProps {
  icon?: ReactNode;
  danger?: boolean;
  onSelect: () => void;
  children: ReactNode;
}

export function MenuItem({ icon, danger = false, onSelect, children }: ItemProps) {
  return (
    <DropdownMenu.Item
      className={danger ? 'menu-item menu-item-danger' : 'menu-item'}
      onSelect={onSelect}
    >
      {icon}
      <span>{children}</span>
    </DropdownMenu.Item>
  );
}

export const MenuSeparator = () => <DropdownMenu.Separator className="menu-separator" />;
