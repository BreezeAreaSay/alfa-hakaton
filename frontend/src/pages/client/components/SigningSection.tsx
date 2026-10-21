import { Button } from '@alfalab/core-components/button';
import { Modal } from '@alfalab/core-components/modal';
import { PasswordInput } from '@alfalab/core-components/password-input';
import { Typography } from '@alfalab/core-components/typography';
import { DocumentPdfMIcon } from '@alfalab/icons-glyph/DocumentPdfMIcon';
import { useState } from 'react';

import { openInNewTab } from '../../../api/client';
import { useSign } from '../../../api/hooks';
import type { Application } from '../../../api/types';
import { useAuth } from '../../../auth/AuthContext';
import { ErrorPlate, KeyValue } from '../../../components/ui';
import { months, percent, rub } from '../../../utils/format';

export function SigningSection({ application }: { application: Application }) {
    const { user } = useAuth();
    const [open, setOpen] = useState(false);
    const [password, setPassword] = useState('');
    const sign = useSign();
    const agreement = application.documents.find((d) => d.kind === 'AGREEMENT');
    const offer = application.offers.find((o) => o.status === 'ACCEPTED');

    const submit = async () => {
        await sign.mutateAsync({ id: application.id, password });
        setOpen(false);
    };

    return (
        <section className='card stack'>
            <div className='stack-8'>
                <Typography.Title tag='h2' view='small' font='system' weight='bold'>
                    Подпишите договор
                </Typography.Title>
                <Typography.Text view='primary-medium' color='secondary' tag='p'>
                    Проверьте договор и график платежей. Подписание — простой электронной подписью: подтвердите
                    паролем от кабинета. Ехать в банк не нужно.
                </Typography.Text>
            </div>
            {offer && (
                <KeyValue
                    items={[
                        ['Продукт', offer.product_name],
                        ['Сумма', rub(offer.amount)],
                        ['Срок', months(offer.term_months)],
                        ['Ставка', `${percent(offer.rate)} годовых`],
                        [offer.payment_label, rub(offer.monthly_payment)],
                    ]}
                />
            )}
            {agreement && (
                <div className='tile row' style={{ flexWrap: 'nowrap' }}>
                    <DocumentPdfMIcon />
                    <div style={{ flex: 1 }}>
                        <Typography.Text view='primary-medium' weight='medium' tag='div'>
                            {agreement.file_name}
                        </Typography.Text>
                        <Typography.Text view='primary-small' color='secondary' tag='div'>
                            Договор и график платежей
                        </Typography.Text>
                    </div>
                    <Button view='secondary' size={40} onClick={() => void openInNewTab(`/api/documents/${agreement.id}/download`)}>
                        Открыть
                    </Button>
                </div>
            )}
            {!user?.can_sign && (
                <ErrorPlate error='У вашей учётной записи нет права подписи от имени компании' title='Подписать не получится' />
            )}
            <div>
                <Button view='primary' size={56} disabled={!user?.can_sign || !agreement} onClick={() => setOpen(true)}>
                    Подписать договор
                </Button>
            </div>
            <Modal open={open} onClose={() => setOpen(false)} size={500}>
                <Modal.Header hasCloser={true} title='Подписание договора' />
                <Modal.Content>
                    <div className='stack-16'>
                        <Typography.Text view='primary-medium' tag='p'>
                            Введите пароль от кабинета — это подтверждает, что договор подписываете вы. В журнале
                            сохранятся время, пользователь и отпечаток документа.
                        </Typography.Text>
                        <PasswordInput
                            label='Пароль'
                            labelView='inner'
                            size={56}
                            block={true}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            autoFocus={true}
                        />
                        <ErrorPlate error={sign.error} title='Не подписано' />
                    </div>
                </Modal.Content>
                <Modal.Footer>
                    <div className='row'>
                        <Button view='primary' size={48} loading={sign.isPending} disabled={!password} onClick={submit}>
                            Подписать
                        </Button>
                        <Button view='secondary' size={48} onClick={() => setOpen(false)}>
                            Отмена
                        </Button>
                    </div>
                </Modal.Footer>
            </Modal>
        </section>
    );
}
