// Sample tours and prices. Set your real products before enabling bank payments.
// Money is stored in integer tetri: 12000 = 120.00 GEL per person.
export const tours = [
  { id: 'kazbegi', title: 'ყაზბეგი და გერგეტი', description: 'მთის გზები, ანანური და კავკასიონის ხედები.', duration: '1 დღე · 10 საათი', priceMinor: 12000, tag: 'მთის თავგადასავალი' },
  { id: 'kakheti', title: 'კახეთის გემოები', description: 'სიღნაღი, ბოდბე და კახური სტუმართმოყვარეობა.', duration: '1 დღე · 8 საათი', priceMinor: 9500, tag: 'ღვინო და კულტურა' },
  { id: 'mtskheta', title: 'მცხეთა და ჯვარი', description: 'ძველი დედაქალაქის ისტორია და ორი მდინარის ხედი.', duration: 'ნახევარი დღე · 5 საათი', priceMinor: 6500, tag: 'ისტორიული მარშრუტი' }
] as const;

export function dateBounds(now = new Date()): { today: string; maxDate: string } {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const end = new Date(`${today}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 365);
  return { today, maxDate: end.toISOString().slice(0, 10) };
}
