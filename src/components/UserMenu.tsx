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
import { User, Key, UserPlus, LogOut } from 'lucide-react';
import { ChangePasswordDialog } from '@/components/ChangePasswordDialog';
import { CreateUserDialog } from '@/components/CreateUserDialog';

interface UserMenuProps {
  userEmail: string;
  onSignOut: () => void;
}

export function UserMenu({ userEmail, onSignOut }: UserMenuProps) {
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [createUserOpen, setCreateUserOpen] = useState(false);

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
          <DropdownMenuItem onSelect={() => setCreateUserOpen(true)}>
            <UserPlus className="w-4 h-4 mr-2" />
            Create User
          </DropdownMenuItem>
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
      <CreateUserDialog
        open={createUserOpen}
        onOpenChange={setCreateUserOpen}
      />
    </>
  );
}
