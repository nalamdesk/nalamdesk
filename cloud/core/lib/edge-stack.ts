import { Stack, type StackProps } from 'aws-cdk-lib';
import { Certificate, CertificateValidation, type ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { HostedZone, type IHostedZone } from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';

export interface CoreEdgeStackProps extends StackProps {
    zoneName: string;
    /** Import this zone instead of creating one (for example, a second stage in the same account). */
    hostedZoneId?: string;
    bridgeDomain: string;
    bookingDomain: string;
}

/**
 * us-east-1 half of Core: CloudFront only accepts certificates from
 * us-east-1, so the hosted zone and the DNS-validated certificates for the
 * bridge and booking domains live here.
 */
export class CoreEdgeStack extends Stack {
    readonly zone: IHostedZone;
    readonly bridgeCertificate: ICertificate;
    readonly bookingCertificate: ICertificate;

    constructor(scope: Construct, id: string, props: CoreEdgeStackProps) {
        super(scope, id, props);
        this.zone = props.hostedZoneId
            ? HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: props.hostedZoneId, zoneName: props.zoneName })
            : new HostedZone(this, 'Zone', { zoneName: props.zoneName });
        this.bridgeCertificate = new Certificate(this, 'BridgeCertificate', {
            domainName: props.bridgeDomain,
            validation: CertificateValidation.fromDns(this.zone)
        });
        this.bookingCertificate = new Certificate(this, 'BookingCertificate', {
            domainName: props.bookingDomain,
            validation: CertificateValidation.fromDns(this.zone)
        });
    }
}
