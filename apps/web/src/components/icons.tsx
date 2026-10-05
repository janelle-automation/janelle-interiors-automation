import type { SVGProps } from 'react';
import {
  Activity,
  ArrowRight,
  BarChart3,
  BellRing,
  Bot,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Columns3,
  Eye,
  EyeOff,
  FilePenLine,
  FileText,
  FolderKanban,
  Inbox,
  KeyRound,
  LayoutDashboard,
  List,
  LogOut,
  MailSearch,
  Mic,
  Moon,
  Plus,
  Search,
  SendHorizontal,
  Settings,
  Sparkles,
  Square,
  Sun,
  Truck,
  User,
  Users,
  UsersRound,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';

/**
 * The app's icons, drawn from Lucide — one consistent, professionally drawn
 * set instead of hand-made paths. The names are the app's own, so a page
 * asks for IconTask, not for whichever Lucide glyph currently stands for it.
 *
 * Same defaults as before (20px, currentColor); width / height / className
 * passed by a caller still win.
 */
type P = SVGProps<SVGSVGElement>;

const icon = (Glyph: LucideIcon, strokeWidth = 1.8) => {
  const Icon = (p: P) => <Glyph size={20} strokeWidth={strokeWidth} aria-hidden="true" {...(p as LucideProps)} />;
  Icon.displayName = `Icon(${Glyph.displayName ?? 'lucide'})`;
  return Icon;
};

export const IconDashboard = icon(LayoutDashboard);
export const IconProjects = icon(FolderKanban);
export const IconVendors = icon(Truck);
export const IconInbox = icon(Inbox);
export const IconDoc = icon(FileText);
export const IconDraft = icon(FilePenLine);
export const IconPrompt = icon(Sparkles);
export const IconBell = icon(BellRing);
export const IconAssistant = icon(Bot);
export const IconTeam = icon(Users);
export const IconMic = icon(Mic);
/** Filled, like a media stop button. */
export const IconStop = (p: P) => <Square size={20} fill="currentColor" strokeWidth={0} aria-hidden="true" {...(p as LucideProps)} />;
export const IconSend = icon(SendHorizontal);
export const IconTask = icon(ClipboardCheck);
export const IconReport = icon(BarChart3);
export const IconSettings = icon(Settings);
export const IconSun = icon(Sun);
export const IconMoon = icon(Moon);
export const IconSearch = icon(Search, 2);
export const IconLogout = icon(LogOut);
export const IconPlus = icon(Plus, 2);
export const IconArrow = icon(ArrowRight, 2);
export const IconKey = icon(KeyRound);
export const IconActivity = icon(Activity);
export const IconPerson = icon(User);
export const IconPeople = icon(UsersRound);
export const IconBoard = icon(Columns3);
export const IconList = icon(List);
export const IconEye = icon(Eye);
export const IconEyeOff = icon(EyeOff);
export const IconMailScan = icon(MailSearch);
export const IconCalendar = icon(CalendarDays);
export const IconChevronLeft = icon(ChevronLeft, 2);
export const IconChevronRight = icon(ChevronRight, 2);
