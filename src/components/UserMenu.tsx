import { useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { User, Key, Users, LogOut, ShieldCheck } from 'lucide-react';
import { ChangePasswordDialog } from '@/components/ChangePasswordDialog';
import { UsersAccessDialog } from '@/components/UsersAccessDialog';
import { SecurityDialog } from '@/components/SecurityDialog';

interface UserMenuProps {
  userEmail: string;
  onSignOut: () => void;
  isOwner?: boolean;
}

export function UserMenu({ userEmail, onSignOut, isOwner = false }: UserMenuProps) {
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [usersAccessOpen, setUsersAccessOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost">
            <User className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="font-normal">
            <p className="text-sm font-medium truncate">{userEmail}</p>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setChangePasswordOpen(true)}>
            <Key className="w-4 h-4 mr-2" />
            Change Password
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setSecurityOpen(true)}>
            <ShieldCheck className="w-4 h-4 mr-2" />
            Two-Factor Auth
          </DropdownMenuItem>
          {isOwner && (
            <DropdownMenuItem onSelect={() => setUsersAccessOpen(true)}>
              <Users className="w-4 h-4 mr-2" />
              Users &amp; Access
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onSignOut}>
            <LogOut className="w-4 h-4 mr-2" />
            Sign Out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ChangePasswordDialog
        open={changePasswordOpen}
        onOpenChange={setChangePasswordOpen}
      />
      {isOwner && (
        <UsersAccessDialog
          open={usersAccessOpen}
          onOpenChange={setUsersAccessOpen}
        />
      )}
      <SecurityDialog
        open={securityOpen}
        onOpenChange={setSecurityOpen}
      />
    </>
  );
}
