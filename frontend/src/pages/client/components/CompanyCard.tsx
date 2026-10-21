import { Button } from '@alfalab/core-components/button';
import { Typography } from '@alfalab/core-components/typography';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../../../api/client';
import { keys } from '../../../api/hooks';
import type { Company } from '../../../api/types';
import { Badge, KeyValue } from '../../../components/ui';
import { date, legalFormLabel, months } from '../../../utils/format';

export function CompanyCard({ company, refreshable = false }: { company: Company; refreshable?: boolean }) {
    const client = useQueryClient();
    const [busy, setBusy] = useState(false);

    const refresh = async () => {
        setBusy(true);
        try {
            const fresh = await api<Company>('/api/company?refresh=true');
            client.setQueryData(keys.company, fresh);
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className='card card--tight stack-16' aria-label='Компания'>
            <div className='row row--between'>
                <div>
                    <Typography.Text view='primary-large' weight='bold' tag='div'>
                        {company.name}
                    </Typography.Text>
                    <Typography.Text view='primary-small' color='secondary' tag='div'>
                        ИНН {company.inn}
                        {company.ogrn ? ` · ${company.legal_form === 'IP' ? 'ОГРНИП' : 'ОГРН'} ${company.ogrn}` : ''}
                    </Typography.Text>
                </div>
                {company.status === 'ACTIVE' ? (
                    <Badge color='green'>Действующая</Badge>
                ) : (
                    company.status_label && <Badge color='red'>{company.status_label}</Badge>
                )}
            </div>
            <KeyValue
                items={[
                    ['Форма', legalFormLabel(company.legal_form)],
                    [
                        'Дата регистрации',
                        company.registration_date
                            ? `${date(company.registration_date)} · ${months(company.business_months ?? 0)}`
                            : '—',
                    ],
                    ['Вид деятельности', company.okved ? `${company.okved} ${company.okved_name ?? ''}` : '—'],
                    ['Руководитель', company.director_name ?? '—'],
                    [
                        'Счёт в банке',
                        company.is_bank_client
                            ? `открыт ${date(company.bank_account_opened_at)}`
                            : 'нет — можно приложить выписку из другого банка',
                    ],
                ]}
            />
            <div className='row row--between'>
                <Typography.Text view='primary-small' color='secondary'>
                    Данные из ЕГРЮЛ / ЕГРИП{company.registry_synced_at ? ` на ${date(company.registry_synced_at)}` : ''}
                </Typography.Text>
                {refreshable && (
                    <Button view='secondary' size={32} onClick={refresh} loading={busy}>
                        Обновить
                    </Button>
                )}
            </div>
        </section>
    );
}
