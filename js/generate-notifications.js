import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function parseDate(str) {
    if (!str || str.trim() === '' || str.toLowerCase() === 'н/т' || 
        str.toLowerCase() === 'задекларировано' || str.toLowerCase() === 'декларация' ||
        str.toLowerCase() === 'бессрочно' || str.toLowerCase() === 'продлить') return null;
    str = str.trim();
    // Формат ММ.ГГГГ
    if (/^\d{2}\.\d{4}$/.test(str)) {
        const [month, year] = str.split('.');
        return new Date(parseInt(year), parseInt(month) - 1, 1);
    }
    // Формат ДД.ММ.ГГГГ
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(str)) {
        const [day, month, year] = str.split('.');
        return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    }
    return null;
}

// Расчёт даты окончания срока носки СИЗ
function calcExpiryDate(issueDateStr, season) {
    const issueDate = parseDate(issueDateStr);
    if (!issueDate) return null;
    
    const expiryDate = new Date(issueDate);
    const months = season === 'winter' ? 24 : 12;
    expiryDate.setMonth(expiryDate.getMonth() + months);
    return expiryDate;
}

export async function generateNotifications() {
    const now = new Date();
    const soonThreshold = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
    const yesterday = new Date(now.getTime() - 24*60*60*1000).toISOString();
    
    let createdCount = 0;

    // ==========================================
    // 1. ПРОВЕРКА ОБУЧЕНИЯ И МЕДОСМОТРОВ (ГРУППИРОВКА ПО ФИО)
    // ==========================================
    try {
        const { data: trainingData } = await supabase.from('employees_training').select('*');
        
        if (trainingData) {
            const dateFields = [
                { key: 'mo_valid', label: 'Медосмотр' },
                { key: 'ot_a_valid', label: 'ОТ (А)' },
                { key: 'ot_b_valid', label: 'ОТ (Б)' },
                { key: 'ot_v_valid', label: 'ОТ (В)' },
                { key: 'pp_valid', label: 'ПП' },
                { key: 'ptm_valid', label: 'ПТМ' },
                { key: 'pozhbez_valid', label: 'Пожарная безопасность' },
                { key: 'a1_valid', label: 'А1' },
                { key: 'b931_valid', label: 'Б.9.31' },
                { key: 'eb_g1_valid', label: 'ЭБ Г.1' },
                { key: 'gaz_b7_valid', label: 'ГАЗ Б.7' },
                { key: 'teplo_g2_valid', label: 'ТЕПЛО Г.2' }
            ];

            const employeeIssues = {};

            for (const emp of trainingData) {
                if (emp.status === 'Уволен') continue;

                emp._issues = [];
                
                for (const field of dateFields) {
                    const validDate = parseDate(emp[field.key]);
                    if (!validDate) continue;
                    
                    if (validDate < now) {
                        const daysOverdue = Math.ceil((now - validDate) / (1000*60*60*24));
                        emp._issues.push({
                            type: 'danger',
                            text: `${field.label} (истёк ${emp[field.key]}, просрочка ${daysOverdue} дн.)`
                        });
                    } else if (validDate <= soonThreshold) {
                        const daysLeft = Math.ceil((validDate - now) / (1000*60*60*24));
                        emp._issues.push({
                            type: 'warning',
                            text: `${field.label} (осталось ${daysLeft} дн., до ${emp[field.key]})`
                        });
                    }
                }

                if (emp._issues.length > 0) {
                    employeeIssues[emp.id] = emp;
                }
            }

            for (const empId in employeeIssues) {
                const emp = employeeIssues[empId];
                
                const hasDanger = emp._issues.some(i => i.type === 'danger');
                const severity = hasDanger ? 'danger' : 'warning';
                
                const issuesList = emp._issues.map(i => `• ${i.text}`).join('\n');
                
                const notification = {
                    type: 'training',
                    title: `${hasDanger ? '⛔' : '⚠️'} Проблемы с обучением: ${emp.full_name}`,
                    message: `${emp.position || ''}\n\n${issuesList}`,
                    link: 'personnel.html',
                    severity: severity
                };

                const { count } = await supabase
                    .from('notifications')
                    .select('*', { count: 'exact', head: true })
                    .eq('title', notification.title)
                    .gte('created_at', yesterday);
                
                if (!count || count === 0) {
                    const { error } = await supabase.from('notifications').insert(notification);
                    if (!error) createdCount++;
                }
            }
        }
    } catch(e) { console.error('Training check error:', e); }


    // ==========================================
    // 2. ПРОВЕРКА СОУТ
    // ==========================================
    try {
        const { data: soutData } = await supabase.from('sout_workplaces').select('*');
        if (soutData) {
            for (const wp of soutData) {
                const validDate = parseDate(wp.valid_until);
                if (!validDate) continue;
                
                let notif = null;
                if (validDate < now) {
                    notif = {
                        type: 'sout',
                        title: `⛔ Истёк срок СОУТ: ${wp.position}`,
                        message: `${wp.company} — № РМ ${wp.rm_number || '—'}. Срок истёк ${wp.valid_until}`,
                        link: 'sout-opr.html',
                        severity: 'danger'
                    };
                } else if (validDate <= soonThreshold) {
                    const daysLeft = Math.ceil((validDate - now) / (1000*60*60*24));
                    notif = {
                        type: 'sout',
                        title: `⚠️ Скоро истекает СОУТ: ${wp.position}`,
                        message: `${wp.company} — осталось ${daysLeft} дн. (до ${wp.valid_until})`,
                        link: 'sout-opr.html',
                        severity: 'warning'
                    };
                }

                if (notif) {
                    const { count } = await supabase
                        .from('notifications')
                        .select('*', { count: 'exact', head: true })
                        .eq('title', notif.title)
                        .gte('created_at', yesterday);
                    
                    if (!count || count === 0) {
                        const { error } = await supabase.from('notifications').insert(notif);
                        if (!error) createdCount++;
                    }
                }
            }
        }
    } catch(e) { console.error('SOUT check error:', e); }


    // ==========================================
    // 3. ПРОВЕРКА СИЗ (с расчётом даты окончания)
    // ==========================================
    try {
        const { data: sizData } = await supabase.from('employees_siz').select('*');
        if (sizData) {
            // Группируем проблемы по сотрудникам
            const employeeSizIssues = {};

            for (const siz of sizData) {
                if (siz.status === 'Уволен') continue;

                const issues = [];

                // Проверяем ЛЕТО (12 месяцев)
                if (siz.summer_issue_date) {
                    const expiryDate = calcExpiryDate(siz.summer_issue_date, 'summer');
                    if (expiryDate) {
                        if (expiryDate < now) {
                            const daysOverdue = Math.ceil((now - expiryDate) / (1000*60*60*24));
                            issues.push({
                                type: 'danger',
                                text: `Летний комплект (выдан ${siz.summer_issue_date}, просрочка ${daysOverdue} дн.)`
                            });
                        } else if (expiryDate <= soonThreshold) {
                            const daysLeft = Math.ceil((expiryDate - now) / (1000*60*60*24));
                            issues.push({
                                type: 'warning',
                                text: `Летний комплект (осталось ${daysLeft} дн., до ${siz.summer_issue_date} + 12 мес.)`
                            });
                        }
                    }
                }

                // Проверяем ЗИМУ (24 месяца)
                if (siz.winter_issue_date) {
                    const expiryDate = calcExpiryDate(siz.winter_issue_date, 'winter');
                    if (expiryDate) {
                        if (expiryDate < now) {
                            const daysOverdue = Math.ceil((now - expiryDate) / (1000*60*60*24));
                            issues.push({
                                type: 'danger',
                                text: `Зимний комплект (выдан ${siz.winter_issue_date}, просрочка ${daysOverdue} дн.)`
                            });
                        } else if (expiryDate <= soonThreshold) {
                            const daysLeft = Math.ceil((expiryDate - now) / (1000*60*60*24));
                            issues.push({
                                type: 'warning',
                                text: `Зимний комплект (осталось ${daysLeft} дн., до ${siz.winter_issue_date} + 24 мес.)`
                            });
                        }
                    }
                }

                // Если есть проблемы — добавляем в список по ФИО
                if (issues.length > 0) {
                    const key = siz.full_name;
                    if (!employeeSizIssues[key]) {
                        employeeSizIssues[key] = {
                            name: siz.full_name,
                            position: siz.position,
                            organization: siz.organization,
                            issues: []
                        };
                    }
                    employeeSizIssues[key].issues.push(...issues);
                }
            }

            // Создаём по одному уведомлению на каждого сотрудника с проблемами СИЗ
            for (const key in employeeSizIssues) {
                const emp = employeeSizIssues[key];
                
                const hasDanger = emp.issues.some(i => i.type === 'danger');
                const severity = hasDanger ? 'danger' : 'warning';
                
                const issuesList = emp.issues.map(i => `• ${i.text}`).join('\n');
                
                const notification = {
                    type: 'siz',
                    title: `${hasDanger ? '⛔' : '⚠️'} Истекает срок СИЗ: ${emp.name}`,
                    message: `${emp.position || ''}${emp.organization ? ' (' + emp.organization + ')' : ''}\n\n${issuesList}`,
                    link: 'siz-registry.html',
                    severity: severity
                };

                const { count } = await supabase
                    .from('notifications')
                    .select('*', { count: 'exact', head: true })
                    .eq('title', notification.title)
                    .gte('created_at', yesterday);
                
                if (!count || count === 0) {
                    const { error } = await supabase.from('notifications').insert(notification);
                    if (!error) createdCount++;
                }
            }
        }
    } catch(e) { console.error('SIZ check error:', e); }


    // Очищаем старые уведомления
    try {
        await supabase.rpc('cleanup_old_notifications');
    } catch(e) { console.log('Cleanup skipped:', e.message); }

    return createdCount;
}
